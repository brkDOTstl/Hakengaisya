// Shared input checks. Every module raises plain Error objects with caller-chosen messages,
// so hosts and tests can match the message without depending on a specific module.

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function requireText(value: unknown, name: string): asserts value is string {
  check(isText(value), `${name} must be nonempty text`);
}

export function requireTexts(values: readonly unknown[], name: string): asserts values is string[] {
  for (const value of values) requireText(value, name);
}

export function requireUniqueTexts(values: unknown, name: string): string[] {
  check(
    Array.isArray(values) && new Set(values).size === values.length,
    `${name} must be a unique array`,
  );
  requireTexts(values, name);
  return values;
}

export const sameMembers = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
