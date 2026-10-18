import { createHash } from 'node:crypto';

export const DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const ACTIVE_TEMPLATES = new Set(['software-delivery', 'product-design']);
const CONTEXT_KEYS = ['project_id', 'template_id', 'role_id', 'task_class', 'difficulty'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SHA = /^[a-f0-9]{64}$/i;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, name) => requireValue(typeof value === 'string' && value.trim(), `${name} needs text`);
const round = value => Math.round(value * 1000) / 1000;
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');

function keysOnly(value, allowed, name) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  for (const key of Object.keys(value)) requireValue(allowed.includes(key), `${name} has unexpected field ${key}`);
}

function scoresValid(scores) {
  keysOnly(scores, DIMENSIONS, 'Ratings');
  for (const value of Object.values(scores)) requireValue(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10), 'Ratings must be null or numbers from 0 to 10');
}

export function validateContext(context) {
  keysOnly(context, [...CONTEXT_KEYS, 'run_id', 'task_id', 'input_fingerprint'], 'Task context');
  for (const key of [...CONTEXT_KEYS, 'run_id', 'task_id', 'input_fingerprint']) text(context[key], key);
  requireValue(ACTIVE_TEMPLATES.has(context.template_id), 'Only technical software and product templates are active');
  requireValue(['routine', 'standard', 'complex'].includes(context.difficulty), 'Unknown task difficulty');
  requireValue(SHA.test(context.input_fingerprint), 'Task input fingerprint must be SHA-256');
  requireValue(!CJK.test(JSON.stringify(context)), 'New context artifacts must use English text');
  return context;
}

export function validateFeedback(feedback) {
  keysOnly(feedback, ['schema_version', 'feedback_id', 'created_at', 'request_id', 'reviewer', 'subject', 'context', 'relationship', 'attribution', 'summary', 'ratings', 'evidence', 'experience'], 'Feedback');
  requireValue(feedback.schema_version === 1, 'Unsupported feedback version');
  requireValue(ID.test(feedback.feedback_id), 'Invalid feedback identifier');
  requireValue(typeof feedback.created_at === 'string' && /Z$|[+-]\d\d:\d\d$/.test(feedback.created_at) && Number.isFinite(Date.parse(feedback.created_at)), 'Feedback timestamp needs an explicit timezone');
  keysOnly(feedback.reviewer, ['model_id', 'employee_id', 'role_id'], 'Reviewer');
  keysOnly(feedback.subject, ['model_id', 'employee_id', 'route_id', 'effort'], 'Subject');
  for (const actor of [feedback.reviewer, feedback.subject]) {
    text(actor.model_id, 'Model identifier');
    text(actor.employee_id, 'Employee identifier');
  }
  text(feedback.reviewer.role_id, 'Reviewer role');
  text(feedback.subject.route_id, 'Subject route');
  text(feedback.subject.effort, 'Subject effort');
  requireValue(feedback.reviewer.model_id !== feedback.subject.model_id && feedback.reviewer.employee_id !== feedback.subject.employee_id, 'Self-rating is not allowed');
  validateContext(feedback.context);
  requireValue(['direct_collaboration', 'artifact_review', 'indirect'].includes(feedback.relationship), 'Unknown reviewer relationship');
  requireValue(['model', 'route', 'environment', 'specification', 'unknown'].includes(feedback.attribution), 'Unknown attribution');
  text(feedback.summary, 'Peer comment');
  scoresValid(feedback.ratings);
  requireValue(Array.isArray(feedback.evidence), 'Evidence must be an array');
  for (const item of feedback.evidence) {
    keysOnly(item, ['path', 'sha256', 'note'], 'Evidence reference');
    text(item.path, 'Evidence path');
    requireValue(item.sha256 === null || (typeof item.sha256 === 'string' && SHA.test(item.sha256)), 'Invalid evidence hash');
    text(item.note, 'Evidence note');
  }
  if (feedback.experience !== undefined) {
    keysOnly(feedback.experience, ['correction_rounds', 'clarification_rounds', 'handoff_rework', 'wall_seconds', 'environment_wait_seconds', 'spec_changes', 'notes'], 'Experience');
    for (const [key, value] of Object.entries(feedback.experience)) {
      if (key === 'notes') requireValue(Array.isArray(value) && value.every(item => typeof item === 'string'), 'Experience notes must be text');
      else requireValue(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0), `Invalid experience metric ${key}`);
    }
  }
  requireValue(!CJK.test(JSON.stringify(feedback)), 'New feedback artifacts must use English text');
  return feedback;
}

// Read data literals only; never execute scripts from the imported page.
export function readDataConstant(source, name) {
  const anchor = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*').exec(source);
  requireValue(anchor, `Missing data constant ${name}`);
  let cursor = anchor.index + anchor[0].length;
  let depth = 0;
  const tokens = [];
  while (cursor < source.length) {
    const rest = source.slice(cursor);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { cursor += whitespace[0].length; continue; }
    const comment = /^\/\/[^\n]*(?:\n|$)|^\/\*[\s\S]*?\*\//.exec(rest);
    if (comment) { cursor += comment[0].length; continue; }
    const quoted = /^"(?:[^"\\]|\\[\s\S])*"/.exec(rest);
    if (quoted) { JSON.parse(quoted[0]); tokens.push(quoted[0]); cursor += quoted[0].length; continue; }
    const character = rest[0];
    if ('[{:},]'.includes(character)) {
      if ('[{'.includes(character)) depth += 1;
      if (']}'.includes(character)) {
        depth -= 1;
        if (tokens.at(-1) === ',') tokens.pop();
      }
      tokens.push(character);
      cursor += 1;
      if (depth === 0) return JSON.parse(tokens.join(''));
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { tokens.push(number[0]); cursor += number[0].length; continue; }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    requireValue(word, `Unsupported data expression in ${name}`);
    const next = rest.slice(word[0].length).trimStart()[0];
    if (next === ':') tokens.push(JSON.stringify(word[0]));
    else {
      requireValue(['true', 'false', 'null'].includes(word[0]), `Executable expression rejected in ${name}`);
      tokens.push(word[0]);
    }
    cursor += word[0].length;
  }
  throw new Error(`Unterminated data constant ${name}`);
}

const SOURCE_MODEL_IDS = {
  'codex-gpt6-astra': 'gpt-6-astra', 'claude-opus-5-5': 'claude-opus-5-5',
  'claude-fable-5-1': 'claude-fable-5-1', 'claude-sonnet-5-5': 'claude-sonnet-5-5',
  'mzk1-sonnet-5-5-high': 'claude-sonnet-5-5', 'muse-spark-1-3': 'muse-spark-1.3',
  'grok-4-7-xhigh': 'grok-4.7', 'claude-haiku-5-5': 'claude-haiku-5-5'
};

export function importLegacyChart(source, sourcePath) {
  const subjects = readDataConstant(source, 'SUBJECTS');
  const historicalLog = readDataConstant(source, 'OBS');
  const dimensionDefinitions = readDataConstant(source, 'DIMS');
  requireValue(Array.isArray(subjects) && Array.isArray(historicalLog), 'Invalid historical data');
  requireValue(!CJK.test(JSON.stringify([subjects, historicalLog, dimensionDefinitions])), 'Imported artifact data contains CJK text');
  const profiles = subjects.map(subject => {
    requireValue(SOURCE_MODEL_IDS[subject.id], `Unknown source model identity ${subject.id}; add an explicit mapping`);
    scoresValid(subject.local);
    return {
      source_subject_id: subject.id, model_id: SOURCE_MODEL_IDS[subject.id], name: subject.name,
      route: subject.route, tier: subject.tier, scores: subject.local,
      claimed_observations: subject.obs, comments: subject.evidence,
      status: 'historical-unverified', identity_status: 'source-label-only'
    };
  });
  const byModel = new Map();
  for (const profile of profiles) {
    if (!byModel.has(profile.model_id)) byModel.set(profile.model_id, []);
    byModel.get(profile.model_id).push(profile);
  }
  const historicalSeeds = [...byModel].map(([model_id, records]) => ({
    model_id,
    scores: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, average(records.map(record => record.scores[dimension]).filter(value => value !== null && value !== undefined))])),
    source_subject_ids: records.map(record => record.source_subject_id),
    status: 'historical-unverified'
  }));
  return {
    history: { schema_version: 1, source_path: sourcePath, source_sha256: digest(source), profiles, dimension_definitions: dimensionDefinitions, historical_log: historicalLog, public_benchmarks_imported: false, raw_observations_imported: 0 },
    registry: { schema_version: 1, epoch: 'import-' + digest(source).slice(0, 12), historical_seeds: historicalSeeds, local_capabilities: [] }
  };
}

export function reviewerWeight(feedback, dimension, registry, policy) {
  const model = feedback.reviewer.model_id;
  const matching = (registry.local_capabilities ?? []).filter(record => record.model_id === model && record.status === 'supported' && record.supporting_tasks >= 2 && CONTEXT_KEYS.every(key => record.context?.[key] === feedback.context[key]));
  const record = matching.at(-1) ?? registry.historical_seeds?.find(seed => seed.model_id === model);
  const dimensions = [...new Set([...policy.credibility.relevant_dimensions, dimension])];
  if (record) scoresValid(record.scores);
  const ability = record ? average(dimensions.map(key => record.scores[key]).filter(value => value !== null && value !== undefined)) : null;
  let credibility = policy.credibility.unknown_weight;
  let basis = 'unknown-neutral';
  if (ability !== null) {
    credibility = Math.max(policy.credibility.minimum_weight, (ability / 10) ** policy.credibility.ability_exponent);
    basis = matching.length ? 'local-context-snapshot' : 'historical-seed-discounted';
    if (!matching.length) credibility = policy.credibility.unknown_weight + policy.credibility.historical_seed_influence * (credibility - policy.credibility.unknown_weight);
  }
  return { weight: credibility * policy.relationship_weights[feedback.relationship], credibility, ability, basis, registry_epoch: registry.epoch };
}

const taskKey = feedback => stableJSON([feedback.context.task_id, feedback.context.input_fingerprint]);
const profileKey = feedback => stableJSON([...CONTEXT_KEYS.map(key => feedback.context[key]), feedback.subject.model_id, feedback.subject.effort]);

export function aggregateFeedback(feedbacks, registry, policy) {
  const ids = new Map();
  const latest = new Map();
  const operations = [];
  for (const feedback of feedbacks) {
    validateFeedback(feedback);
    const hash = digest(feedback);
    requireValue(!ids.has(feedback.feedback_id) || ids.get(feedback.feedback_id) === hash, 'Conflicting records share a feedback identifier');
    if (ids.has(feedback.feedback_id)) continue;
    ids.set(feedback.feedback_id, hash);
    if (feedback.attribution !== 'model') { operations.push(feedback); continue; }
    const key = stableJSON([profileKey(feedback), taskKey(feedback), feedback.reviewer.model_id]);
    const prior = latest.get(key);
    const timestampDelta = prior ? Date.parse(feedback.created_at) - Date.parse(prior.created_at) : 1;
    if (prior && timestampDelta === 0) requireValue(digest(prior) === hash, 'Conflicting peer opinions have identical timestamps');
    if (!prior || timestampDelta > 0) latest.set(key, feedback);
  }
  const groups = new Map();
  for (const feedback of latest.values()) {
    const key = profileKey(feedback);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feedback);
  }
  const profiles = [];
  for (const records of groups.values()) {
    const first = records[0];
    const context = Object.fromEntries(CONTEXT_KEYS.map(key => [key, first.context[key]]));
    const dimensions = {};
    for (const dimension of DIMENSIONS) {
      const byTask = new Map();
      for (const record of records) {
        const score = record.ratings[dimension];
        if (score === null || score === undefined) continue;
        const key = taskKey(record);
        if (!byTask.has(key)) byTask.set(key, []);
        byTask.get(key).push({ feedback_id: record.feedback_id, reviewer_model: record.reviewer.model_id, score, ...reviewerWeight(record, dimension, registry, policy) });
      }
      const taskEstimates = [...byTask].map(([key, votes]) => {
        const total = votes.reduce((sum, vote) => sum + vote.weight, 0);
        return { task_input_key: JSON.parse(key), score: votes.reduce((sum, vote) => sum + vote.score * vote.weight, 0) / total, spread: Math.max(...votes.map(vote => vote.score)) - Math.min(...votes.map(vote => vote.score)), dominant_peer_share: Math.max(...votes.map(vote => vote.weight)) / total, votes };
      });
      const peers = new Set(taskEstimates.flatMap(task => task.votes.map(vote => vote.reviewer_model)));
      const disputed = taskEstimates.some(task => task.spread >= policy.confidence.disagreement_gap);
      const supported = taskEstimates.length >= policy.confidence.minimum_distinct_task_inputs && peers.size >= policy.confidence.minimum_distinct_peer_models && taskEstimates.every(task => task.dominant_peer_share <= policy.credibility.max_single_peer_share_for_supported);
      dimensions[dimension] = { score: taskEstimates.length ? round(average(taskEstimates.map(task => task.score))) : null, confidence: !taskEstimates.length ? 'unmeasured' : disputed ? 'disputed' : supported ? 'supported-peer-feedback' : 'provisional', distinct_task_inputs: taskEstimates.length, distinct_peer_models: peers.size, tasks: taskEstimates };
    }
    const weights = policy.role_weights[context.role_id] ?? Object.fromEntries(DIMENSIONS.map(key => [key, 1]));
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const measured = Object.entries(weights).filter(([key]) => dimensions[key].score !== null);
    const measuredWeight = measured.reduce((sum, [, weight]) => sum + weight, 0);
    const coverage = measuredWeight / totalWeight;
    const eligible = coverage >= policy.dispatch.minimum_dimension_coverage && measured.every(([key]) => dimensions[key].confidence === 'supported-peer-feedback');
    profiles.push({
      model_id: first.subject.model_id, effort: first.subject.effort, context, dimensions,
      role_fit: { estimate: measuredWeight ? round(measured.reduce((sum, [key, weight]) => sum + dimensions[key].score * weight, 0) / measuredWeight) : null, coverage: round(coverage), eligible_for_dispatch_advice: eligible, automatic_assignment: false },
      routes: [...new Set(records.map(record => record.subject.route_id))],
      feedback: records, registry_epoch: registry.epoch
    });
  }
  return { schema_version: 1, policy_version: policy.version, registry_epoch: registry.epoch, registry_sha256: digest(registry), received_records: ids.size, retained_model_feedback: latest.size, profiles, operational_feedback: operations };
}

export function surveyDue(state, completedTasks, now, policy) {
  const elapsed = Date.parse(now) - Date.parse(state.last_poll_at);
  requireValue(Number.isFinite(elapsed) && Number.isInteger(completedTasks) && completedTasks >= 0 && Number.isInteger(state.completed_task_count) && state.completed_task_count >= 0, 'Invalid survey scheduling state');
  return completedTasks - state.completed_task_count >= policy.survey.minimum_new_completed_tasks && elapsed >= policy.survey.periodic_interval_seconds * 1000;
}

export function buildSurvey(context, participants) {
  validateContext(context);
  requireValue(Array.isArray(participants) && participants.length > 1, 'A peer survey needs task participants');
  const unique = new Map();
  for (const participant of participants) {
    for (const key of ['model_id', 'employee_id', 'role_id', 'route_id', 'effort']) text(participant[key], key);
    requireValue(!unique.has(participant.employee_id), 'Duplicate survey employee');
    unique.set(participant.employee_id, participant);
  }
  const requests = participants.map(reviewer => ({
    request_id: 'survey-' + digest([context, reviewer.employee_id, participants]).slice(0, 20),
    reviewer, context,
    targets: participants.filter(subject => subject.model_id !== reviewer.model_id),
    response_record_template: {
      schema_version: 1, feedback_id: 'REPLACE-WITH-UNIQUE-ID', created_at: 'REPLACE-WITH-ISO-TIME',
      request_id: 'REPLACE-WITH-THIS-REQUEST-ID',
      reviewer: { model_id: reviewer.model_id, employee_id: reviewer.employee_id, role_id: reviewer.role_id },
      subject: { model_id: 'TARGET-MODEL-ID', employee_id: 'TARGET-EMPLOYEE-ID', route_id: 'TARGET-ROUTE', effort: 'TARGET-EFFORT' },
      context, relationship: 'direct_collaboration', attribution: 'model', summary: 'Your observed local working experience in English.',
      ratings: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, null])), evidence: [],
      experience: { correction_rounds: null, clarification_rounds: null, handoff_rework: null, wall_seconds: null, environment_wait_seconds: null, spec_changes: null, notes: [] }
    },
    prompt: 'Evaluate only the listed peers you worked with on this task. Return an array of version-1 feedback records. Preserve task difficulty and concrete working experience. Use English comments, 0-10 ratings only for observed dimensions, and null for unmeasured dimensions. Separate model contribution from route, environment, and specification problems. Do not supply reviewer weights. Ratings are your own local-work impressions, not benchmark scores.'
  })).filter(request => request.targets.length);
  return { schema_version: 1, context, requests };
}

export async function collectSurvey(plan, askPeer) {
  const results = await Promise.allSettled(plan.requests.map(async request => {
    const feedbacks = await askPeer(request);
    requireValue(Array.isArray(feedbacks), 'Peer response must be an array');
    for (const feedback of feedbacks) {
      validateFeedback(feedback);
      requireValue(feedback.request_id === request.request_id, 'Survey request mismatch');
      requireValue(feedback.reviewer.employee_id === request.reviewer.employee_id && feedback.reviewer.model_id === request.reviewer.model_id && feedback.reviewer.role_id === request.reviewer.role_id, 'Survey reviewer mismatch');
      requireValue(request.targets.some(target => ['model_id', 'employee_id', 'route_id', 'effort'].every(key => target[key] === feedback.subject[key])), 'Survey target mismatch');
      requireValue(stableJSON(feedback.context) === stableJSON(request.context), 'Survey task context mismatch');
    }
    return feedbacks;
  }));
  return { feedback: results.flatMap(result => result.status === 'fulfilled' ? result.value : []), failures: results.flatMap((result, index) => result.status === 'rejected' ? [{ request_id: plan.requests[index].request_id, error: String(result.reason.message ?? result.reason) }] : []) };
}
