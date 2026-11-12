import { createHash } from 'node:crypto';
import { isRecord } from './validate.ts';

// Deterministic key-sorted JSON that omits undefined object members, matching JSON.stringify
// round-trips across Node and Python consumers.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(',')}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
