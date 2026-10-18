import { createHash } from 'node:crypto';

export const DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
export const SKILLS = ['basic-computation', 'routine-scripting', 'implementation', 'technical-planning', 'diagnosis', 'code-review', 'reverse-engineering', 'web-research', 'database-inspection', 'verification', 'technical-product-design'];
export const KINDS = ['local_work', 'simulation', 'historical_summary'];
export const TASK_TYPES = [...SKILLS, 'mixed-technical-work'];
export const assert = (condition, message, status = 400) => { if (!condition) throw Object.assign(new Error(message), { status }); };
export const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
export const sha256 = text => createHash('sha256').update(text).digest('hex');

export function object(value, allowed, required = allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  for (const key of Object.keys(value)) assert(allowed.includes(key), 'Field not accepted: ' + key);
  for (const key of required) assert(Object.hasOwn(value, key), 'Missing field: ' + key);
}
export function identifier(value) {
  assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value), 'Invalid identifier');
}
export function finite(value, max = 1e9) { assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max, 'Invalid numeric value'); }

// These checks reduce obvious leaks; free-text de-identification also needs local review.
export const privacyPatterns = [
  /[a-z]:[\\/][^\s]*/ig,
  /\\\\[a-z0-9_.-]+[\\/][^\s]*/ig,
  /(?:\/(?:users|home|mnt|tmp|var|srv)\/|(?:src|runs|harness|collab)[\\/])[^\s]*/ig,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig,
  /\b(?:sk-|gh[pousr]_|github_pat_)[a-z0-9_-]{10,}/ig,
  /\b(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*\S+/ig,
  /\bBearer\s+[a-z0-9._~-]+/ig,
  /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /```[\s\S]*?```/g
];
export function redactText(value) {
  assert(typeof value === 'string', 'Expected text');
  return privacyPatterns.reduce((text, pattern) => text.replace(new RegExp(pattern.source, pattern.flags), '[redacted]'), value);
}
export function safeText(value, max = 1200) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'Invalid summary text');
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Control characters are not accepted');
  assert(redactText(value) === value, 'Possible private content: redact locally before submitting');
}

export function validateReport(report) {
  object(report, ['version', 'report_id', 'reviewer_model', 'subject_model', 'route', 'effort', 'task_token', 'evaluation_kind', 'task', 'ratings', 'comment', 'example', 'guidance', 'relationship', 'attribution', 'usage']);
  assert(report.version === 1, 'Unsupported report version');
  for (const key of ['report_id', 'reviewer_model', 'subject_model', 'route', 'effort']) identifier(report[key]);
  assert(report.reviewer_model !== report.subject_model, 'Self-evaluation is not accepted');
  assert(typeof report.task_token === 'string' && /^[a-f0-9]{64}$/.test(report.task_token), 'Use an opaque task token');
  assert(KINDS.includes(report.evaluation_kind), 'Unknown evaluation kind');
  object(report.task, ['domain', 'type', 'difficulty', 'skills']);
  assert(['software-engineering', 'technical-product'].includes(report.task.domain), 'Only technical domains are enabled');
  assert(TASK_TYPES.includes(report.task.type), 'Use a supported task type, not a local project or task name');
  assert(['routine', 'standard', 'complex'].includes(report.task.difficulty), 'Unknown difficulty');
  assert(Array.isArray(report.task.skills) && report.task.skills.length > 0 && report.task.skills.length <= 5 && new Set(report.task.skills).size === report.task.skills.length && report.task.skills.every(skill => SKILLS.includes(skill)), 'Use supported skill tags');
  object(report.ratings, DIMENSIONS, []);
  for (const value of Object.values(report.ratings)) if (value !== null) finite(value, 10);
  for (const key of ['comment', 'example', 'guidance']) safeText(report[key]);
  assert(['direct', 'review', 'indirect'].includes(report.relationship), 'Unknown relationship');
  assert(['model', 'route', 'environment', 'specification', 'unknown'].includes(report.attribution), 'Unknown attribution');
  object(report.usage, ['input_tokens', 'output_tokens', 'cost_usd', 'wall_seconds']);
  for (const value of Object.values(report.usage)) if (value !== null) finite(value);
  return report;
}
