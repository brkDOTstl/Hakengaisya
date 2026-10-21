import type { Dimension, Report } from './contract.ts';
import { canonical, DIMENSIONS } from './contract.ts';
import type {
  DimensionEstimate,
  DispatchNeeds,
  DisplayRow,
  OperationalNote,
  Profile,
  Projection,
  Recommendation,
  RegistryEntry,
  ReportRow,
  Usage,
  Vote,
} from './types.ts';

interface ProfileContext {
  model_id: string;
  evaluation_kind: Profile['evaluation_kind'];
  domain: Profile['domain'];
  task_type: Profile['task_type'];
  difficulty: Profile['difficulty'];
  skill: Profile['skill'];
  effort: string;
  route: string;
  rows: ReportRow[];
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

function weight(report: Report, dimension: Dimension, registry: RegistryEntry[]): number {
  const anchor = registry.find((item) => item.model_id === report.reviewer_model);
  const abilities = [...new Set<Dimension>(['D1', 'D4', dimension])]
    .map((key) => anchor?.scores[key])
    .filter((value): value is number => typeof value === 'number');
  const ability = mean(abilities);
  const base = ability === null ? 0.25 : 0.25 + 0.5 * (Math.max(0.1, (ability / 10) ** 2) - 0.25);
  return base * { direct: 1, review: 0.8, indirect: 0.35 }[report.relationship];
}

export function buildProfiles(rows: ReportRow[], registry: RegistryEntry[] = []): Projection {
  const latest = new Map<string, ReportRow>();
  const operational: OperationalNote[] = [];
  for (const row of rows) {
    const report = row.report;
    if (report.attribution !== 'model') {
      operational.push({
        report_id: report.report_id,
        model: report.subject_model,
        attribution: report.attribution,
        guidance: report.guidance,
      });
      continue;
    }
    const key = canonical([
      row.collection_id,
      report.task_token,
      report.reviewer_model,
      report.subject_model,
      report.evaluation_kind,
      report.task,
      report.effort,
      report.route,
    ]);
    latest.set(key, row);
  }
  const contexts = new Map<string, ProfileContext>();
  for (const row of latest.values())
    for (const skill of row.report.task.skills) {
      const report = row.report;
      const key = canonical([
        report.subject_model,
        report.evaluation_kind,
        report.task.domain,
        report.task.type,
        report.task.difficulty,
        skill,
        report.effort,
        report.route,
      ]);
      let context = contexts.get(key);
      if (!context) {
        context = {
          model_id: report.subject_model,
          evaluation_kind: report.evaluation_kind,
          domain: report.task.domain,
          task_type: report.task.type,
          difficulty: report.task.difficulty,
          skill,
          effort: report.effort,
          route: report.route,
          rows: [],
        };
        contexts.set(key, context);
      }
      context.rows.push(row);
    }
  const profiles = [...contexts.values()].map((context): Profile => {
    const { rows: samples, ...profile } = context;
    // Filled for every dimension in the loop below before it is read.
    const dimensions = {} as Record<Dimension, DimensionEstimate>;
    for (const dimension of DIMENSIONS) {
      const tasks = new Map<string, Vote[]>();
      for (const row of samples) {
        const score = row.report.ratings[dimension];
        if (score === null || score === undefined) continue;
        const key = canonical([row.collection_id, row.report.task_token]);
        let votes = tasks.get(key);
        if (!votes) {
          votes = [];
          tasks.set(key, votes);
        }
        const vote: Vote = {
          score,
          weight: weight(row.report, dimension, registry),
          reviewer: row.report.reviewer_model,
          report_id: row.report.report_id,
        };
        const prior = votes.findIndex((item) => item.reviewer === vote.reviewer);
        if (prior < 0) votes.push(vote);
        else votes[prior] = vote;
      }
      const perTask = [...tasks.values()].map((votes) => ({
        score:
          votes.reduce((sum, vote) => sum + vote.score * vote.weight, 0) /
          votes.reduce((sum, vote) => sum + vote.weight, 0),
        spread:
          Math.max(...votes.map((vote) => vote.score)) -
          Math.min(...votes.map((vote) => vote.score)),
        votes,
      }));
      const peers = new Set(perTask.flatMap((task) => task.votes.map((vote) => vote.reviewer)));
      const disputed = perTask.some((task) => task.spread >= 4);
      const concentrated = perTask.some(
        (task) =>
          Math.max(...task.votes.map((vote) => vote.weight)) /
            task.votes.reduce((sum, vote) => sum + vote.weight, 0) >
          0.75,
      );
      dimensions[dimension] = {
        score: round(mean(perTask.map((task) => task.score))),
        samples: perTask.length,
        peers: peers.size,
        support: !perTask.length
          ? 'unmeasured'
          : disputed
            ? 'mixed-observations'
            : perTask.length >= 2 && peers.size >= 2 && !concentrated
              ? 'supported-peer-observations'
              : 'limited-observations',
        tasks: perTask,
      };
    }
    const values = Object.values(dimensions)
      .map((item) => item.score)
      .filter((value): value is number => value !== null);
    // Repeated reviewers of one task must not multiply its cost or latency samples.
    const usage = new Map<string, Usage>();
    for (const row of samples)
      usage.set(canonical([row.collection_id, row.report.task_token]), row.report.usage);
    return {
      ...profile,
      dimensions,
      capability_estimate: round(mean(values)),
      observed_cost_usd: mean(
        [...usage.values()]
          .map((item) => item.cost_usd)
          .filter((value): value is number => value !== null),
      ),
      observed_wall_seconds: mean(
        [...usage.values()]
          .map((item) => item.wall_seconds)
          .filter((value): value is number => value !== null),
      ),
      guidance: samples.map((row) => ({
        report_id: row.report.report_id,
        comment: row.report.comment,
        example: row.report.example,
        guidance: row.report.guidance,
      })),
      meaning: 'Skill and task-fit guidance; no disciplinary action.',
    };
  });
  return {
    profiles,
    operational,
    records: rows.length,
    weighting_basis:
      'Frozen historical-local credibility seeds, discounted; unknown reviewers receive a neutral weight.',
  };
}

export function recommend(profiles: Profile[], needs: DispatchNeeds): Recommendation {
  const required: Dimension[] = needs.dimensions ?? ['D1', 'D2', 'D6'];
  const threshold = needs.minimum_score ?? 7;
  const candidates = profiles.filter(
    (profile) =>
      profile.evaluation_kind === 'local_work' &&
      profile.skill === needs.skill &&
      profile.difficulty === needs.difficulty &&
      (!needs.task_type || profile.task_type === needs.task_type) &&
      (!needs.domain || profile.domain === needs.domain) &&
      required.every(
        (dimension) =>
          // Null scores never reach a positive threshold; the comparison stays as written.
          (profile.dimensions[dimension]?.score as number) >= threshold &&
          profile.dimensions[dimension]?.support === 'supported-peer-observations',
      ),
  );
  const known = candidates.filter(
    (profile) =>
      profile.observed_cost_usd !== null &&
      profile.observed_wall_seconds !== null &&
      (needs.max_cost_usd === undefined || profile.observed_cost_usd <= needs.max_cost_usd) &&
      (needs.max_wall_seconds === undefined ||
        profile.observed_wall_seconds <= needs.max_wall_seconds),
  );
  known.sort(
    (a, b) =>
      // The filter above kept only profiles with known cost and duration.
      (a.observed_cost_usd as number) - (b.observed_cost_usd as number) ||
      (a.observed_wall_seconds as number) - (b.observed_wall_seconds as number),
  );
  return {
    recommended: known[0] ?? null,
    eligible: known,
    unknown_cost_or_speed: candidates.filter(
      (profile) => profile.observed_cost_usd === null || profile.observed_wall_seconds === null,
    ),
    strategy:
      'Meet skill and difficulty requirements first; prefer the lowest observed cost, then faster delivery.',
    cost_basis: 'Reported historical task cost, not a guaranteed quote for the next task.',
    automatic_execution: false,
  };
}

export function displayRanking(profiles: Profile[]): DisplayRow[] {
  const groups = new Map<string, Profile[]>();
  for (const profile of profiles) {
    const key = canonical([
      profile.model_id,
      profile.route,
      profile.effort,
      profile.domain,
      profile.task_type,
      profile.difficulty,
      profile.evaluation_kind,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(profile);
  }
  return [...groups.values()]
    .map((items): DisplayRow => {
      const first = items[0];
      const dimensions = Object.fromEntries(
        DIMENSIONS.map((dimension) => [
          dimension,
          round(
            mean(
              items
                .map((profile) => profile.dimensions[dimension].score)
                .filter((value): value is number => value !== null),
            ),
          ),
        ]),
      ) as Record<Dimension, number | null>;
      return {
        model_id: first.model_id,
        route: first.route,
        effort: first.effort,
        domain: first.domain,
        task_type: first.task_type,
        difficulty: first.difficulty,
        evaluation_kind: first.evaluation_kind,
        tags: [...new Set(items.map((profile) => profile.skill))],
        dimensions,
        display_score: round(
          mean(Object.values(dimensions).filter((value): value is number => value !== null)),
        ),
        cost_usd: first.observed_cost_usd,
        wall_seconds: first.observed_wall_seconds,
        use: 'Optional human display only; dispatch uses detailed profiles.',
      };
    })
    .sort((a, b) => (b.display_score ?? -1) - (a.display_score ?? -1));
}
