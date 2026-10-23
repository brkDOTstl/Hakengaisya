import { check } from '../../../lib/validate.ts';

export const HARNESS2 = {
  repository: 'https://github.com/google-research/harness2',
  revision: '1cfe254e8d25b15f37048c3730134686abe60335',
  version: '0.1.0',
} as const;
export interface ImprovementInput {
  enabled: boolean;
  scope?: string;
  max_host_calls?: number;
}
export type ImprovementPolicy =
  | { enabled: false }
  | { enabled: true; scope: string; max_host_calls: number };
export function normalizeImprovement(value?: unknown): ImprovementPolicy {
  if (value === undefined) return { enabled: false };
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Invalid improvement policy',
  );
  const record = value as Record<string, unknown>;
  check(
    Object.keys(record).every((key) => ['enabled', 'scope', 'max_host_calls'].includes(key)),
    'Unknown improvement policy fields',
  );
  check(typeof record.enabled === 'boolean', 'Improvement enabled must be boolean');
  if (!record.enabled) return { enabled: false };
  check(
    typeof record.scope === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(record.scope),
    'Enabled improvement needs an explicit project learning scope',
  );
  const maximum = record.max_host_calls ?? 9;
  check(
    typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 12,
    'Improvement max_host_calls must be between 1 and 12',
  );
  return { enabled: true, scope: record.scope, max_host_calls: maximum };
}
