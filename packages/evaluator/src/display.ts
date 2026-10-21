import { readFile } from 'node:fs/promises';
import type { Dimension } from './contract.ts';
import { canonical, DIMENSIONS } from './contract.ts';
import { displayRanking } from './profiles.ts';
import type {
  DimensionDefinition,
  GuidanceEntry,
  ModelDetail,
  Profile,
  ProfileFilters,
  PublicReference,
  PublicReferences,
  PublicSnapshot,
} from './types.ts';

export const dimensionDefinitions: DimensionDefinition[] = [
  {
    id: 'D1',
    name: 'Evidence precision',
    evaluates:
      'Accuracy of facts, citations, locations, and verification claims; distinguishes observations from assumptions.',
  },
  {
    id: 'D2',
    name: 'Change precision',
    evaluates:
      'Whether implementation follows the requested scope and interfaces, avoids stray edits, and passes relevant checks.',
  },
  {
    id: 'D3',
    name: 'Diagnosis depth',
    evaluates:
      'Root-cause analysis, rejection of incorrect hypotheses, and useful explanations of real technical problems.',
  },
  {
    id: 'D4',
    name: 'Review rigour',
    evaluates:
      'Finding real defects, avoiding false alarms, and covering the important parts of a technical review.',
  },
  {
    id: 'D5',
    name: 'Effective delivery speed',
    evaluates:
      'Useful output per task, considering elapsed time, retries, and correction effort within comparable task classes.',
  },
  {
    id: 'D6',
    name: 'Reliability and coordination',
    evaluates:
      'Following constraints, honest reporting of limits, appropriate stopping, clear handoffs, and dependable collaboration.',
  },
];

// Bundled fixture maintained with this package; parsed to its documented shape.
const snapshot: PublicSnapshot = JSON.parse(
  await readFile(new URL('../fixtures/public-benchmarks.json', import.meta.url), 'utf8'),
);
export function publicReference(modelId: string): PublicReference | null {
  const record = snapshot.models.find((model) => model.model_id === modelId);
  return record
    ? {
        ...structuredClone(record),
        checked_on: snapshot.checked_on,
        assessment_basis:
          'AI-written coarse interpretation of the linked vendor report, not a measured local skill score.',
        dispatch_eligible: false,
      }
    : null;
}
export function publicReferences(): PublicReferences {
  return {
    checked_on: snapshot.checked_on,
    purpose: snapshot.purpose,
    // Every id comes from the same snapshot, so each lookup succeeds.
    models: snapshot.models.map((model) => publicReference(model.model_id)) as PublicReference[],
  };
}

export function modelDetail(
  profiles: Profile[],
  modelId: string,
  filters: ProfileFilters = {},
): ModelDetail {
  const selected = profiles.filter(
    (profile) =>
      profile.model_id === modelId &&
      Object.entries(filters).every(
        ([key, value]) => !value || profile[key as keyof Profile] === value,
      ),
  );
  const summaries = displayRanking(selected);
  // A chart represents one selected context; never merge unrelated routes or difficulties.
  const radar: Record<Dimension, number | null> =
    summaries.length === 1
      ? summaries[0].dimensions
      : (Object.fromEntries(DIMENSIONS.map((id) => [id, null])) as Record<
          Dimension,
          number | null
        >);
  const comments = new Map<string, GuidanceEntry>();
  for (const profile of selected)
    for (const item of profile.guidance) comments.set(canonical(item), item);
  return {
    model_id: modelId,
    filters,
    contexts: summaries,
    profiles: selected,
    comments: [...comments.values()],
    radar,
    radar_scope:
      summaries.length === 1 ? 'Selected display context' : 'Choose one context to draw a radar',
    public_reference: publicReference(modelId),
    dimension_definitions: dimensionDefinitions,
  };
}
