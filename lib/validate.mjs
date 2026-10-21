// Shared input checks. Every module raises plain Error objects with caller-chosen messages,
// so hosts and tests can match the message without depending on a specific module.

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export const isText = (value) => typeof value === 'string' && value.trim().length > 0;

export function requireText(value, name) {
  check(isText(value), `${name} must be nonempty text`);
}

export function requireTexts(values, name) {
  for (const value of values) requireText(value, name);
}

export function requireUniqueTexts(values, name) {
  check(
    Array.isArray(values) && new Set(values).size === values.length,
    `${name} must be a unique array`,
  );
  requireTexts(values, name);
  return values;
}

export const sameMembers = (left, right) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
