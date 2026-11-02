import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { check, isRecord, isText } from './validate.ts';

export interface EvaluatorConfiguration {
  endpoint?: string;
  queue_dir?: string;
  task_salt_file?: string;
  client_id?: string;
  reviewer_model?: string;
  private_key_file?: string;
  reviewers?: ReviewerIdentity[];
}

export interface ReviewerIdentity {
  reviewer_model: string;
  client_id: string;
  private_key_file: string;
}

export interface CostConfiguration {
  allow_api_equivalent: boolean;
  max_age_days: number;
  task_token_scope?: string;
}

export interface LearningConfiguration {
  state_dir: string;
  reuse_enabled: boolean;
  scope?: string;
  python?: string;
  upstream?: string;
}

export interface IntegrationConfig {
  version: 1;
  evaluator?: EvaluatorConfiguration;
  cost?: CostConfiguration;
  learning?: LearningConfiguration;
}

type Configured = 'configured' | 'unconfigured';
export interface IntegrationConfigStatus {
  file: Configured;
  evaluator: {
    state: Configured;
    profiles: Configured;
    local_feedback: Configured;
    submission: Configured;
    missing: string[];
  };
  cost: { state: Configured; allowed: boolean | null; queue: Configured };
  learning: { state: Configured; reuse_enabled: boolean | null; missing: string[] };
  boundary: string;
}

export interface IntegrationConfigResult {
  config: IntegrationConfig | null;
  status: IntegrationConfigStatus;
}

const BOUNDARY =
  'Configuration is syntax-checked only; file paths, service availability, model identity and permissions are not verified. No secrets are created, read or transmitted, and no service or model is started.';
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are forbidden in config values.
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const SECRET = /^(?:sk-|gh[pousr]_|github_pat_|eyJ[a-zA-Z0-9_-]{8,}\.)/i;

function fields(
  value: unknown,
  allowed: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  check(
    isRecord(value) && Object.keys(value).every((key) => allowed.includes(key)),
    `Invalid or unknown ${name} fields`,
  );
}

function localPath(value: unknown, name: string): string {
  check(
    isText(value) && value.length <= 4096 && !CONTROLS.test(value) && !CJK.test(value),
    `${name} must be a local path`,
  );
  check(
    path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value),
    `${name} must be an absolute local path`,
  );
  const parts = value.split(/[\\/]+/);
  check(
    !parts.some((part) => part === '.' || part === '..'),
    `${name} cannot contain dot segments`,
  );
  check(!parts.some((part) => SECRET.test(part)), `${name} cannot contain credential values`);
  return path.normalize(value);
}

function label(value: unknown, name: string): string {
  check(
    typeof value === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) &&
      !SECRET.test(value),
    `${name} must be a non-secret identifier`,
  );
  return value;
}

function evaluatorOrigin(value: unknown): string {
  check(
    isText(value) && value.length <= 1024 && !CONTROLS.test(value),
    'Evaluator endpoint must be a loopback origin',
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Evaluator endpoint must be a loopback origin');
  }
  check(
    url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname),
    'Evaluator endpoint must use numeric HTTP loopback',
  );
  check(
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'Evaluator endpoint must be a clean origin',
  );
  return url.origin;
}

export function validateIntegrationConfig(value: unknown): IntegrationConfig {
  fields(value, ['version', 'evaluator', 'cost', 'learning'], 'config');
  check(value.version === 1, 'Unsupported integration config version');
  const result: IntegrationConfig = { version: 1 };
  if (value.evaluator !== undefined) {
    fields(
      value.evaluator,
      [
        'endpoint',
        'queue_dir',
        'task_salt_file',
        'client_id',
        'reviewer_model',
        'private_key_file',
        'reviewers',
      ],
      'evaluator',
    );
    const e: EvaluatorConfiguration = {};
    for (const key of ['queue_dir', 'task_salt_file', 'private_key_file'] as const)
      if (value.evaluator[key] !== undefined) e[key] = localPath(value.evaluator[key], key);
    for (const key of ['client_id', 'reviewer_model'] as const)
      if (value.evaluator[key] !== undefined) e[key] = label(value.evaluator[key], key);
    if (value.evaluator.endpoint !== undefined)
      e.endpoint = evaluatorOrigin(value.evaluator.endpoint);
    if (value.evaluator.reviewers !== undefined) {
      check(
        !['client_id', 'reviewer_model', 'private_key_file'].some((key) =>
          Object.hasOwn(value.evaluator as Record<string, unknown>, key),
        ),
        'Use either legacy reviewer fields or the reviewers array, not both',
      );
      check(
        Array.isArray(value.evaluator.reviewers) && value.evaluator.reviewers.length <= 256,
        'Reviewers must be a bounded array',
      );
      e.reviewers = value.evaluator.reviewers.map((item): ReviewerIdentity => {
        fields(item, ['reviewer_model', 'client_id', 'private_key_file'], 'reviewer');
        return {
          reviewer_model: label(item.reviewer_model, 'reviewer_model'),
          client_id: label(item.client_id, 'client_id'),
          private_key_file: localPath(item.private_key_file, 'private_key_file'),
        };
      });
      check(
        new Set(e.reviewers.map((item) => item.reviewer_model)).size === e.reviewers.length,
        'Reviewer model identities must be unique',
      );
      check(
        new Set(e.reviewers.map((item) => item.client_id)).size === e.reviewers.length,
        'Reviewer client identities must be unique',
      );
    }
    result.evaluator = e;
  }
  if (value.cost !== undefined) {
    fields(value.cost, ['allow_api_equivalent', 'max_age_days', 'task_token_scope'], 'cost');
    check(
      typeof value.cost.allow_api_equivalent === 'boolean',
      'Cost policy must explicitly allow or decline API equivalents',
    );
    check(
      Number.isInteger(value.cost.max_age_days) &&
        (value.cost.max_age_days as number) >= 1 &&
        (value.cost.max_age_days as number) <= 365,
      'Cost max_age_days must be 1 to 365',
    );
    check(
      value.cost.task_token_scope === undefined ||
        (typeof value.cost.task_token_scope === 'string' &&
          /^[a-f0-9]{64}$/.test(value.cost.task_token_scope)),
      'Invalid task token scope',
    );
    result.cost = {
      allow_api_equivalent: value.cost.allow_api_equivalent,
      max_age_days: value.cost.max_age_days as number,
      ...(value.cost.task_token_scope === undefined
        ? {}
        : { task_token_scope: value.cost.task_token_scope as string }),
    };
  }
  if (value.learning !== undefined) {
    fields(
      value.learning,
      ['state_dir', 'reuse_enabled', 'scope', 'python', 'upstream'],
      'learning',
    );
    check(typeof value.learning.reuse_enabled === 'boolean', 'Learning reuse must be explicit');
    const learning: LearningConfiguration = {
      state_dir: localPath(value.learning.state_dir, 'state_dir'),
      reuse_enabled: value.learning.reuse_enabled,
    };
    if (value.learning.scope !== undefined) {
      check(
        typeof value.learning.scope === 'string' &&
          /^[a-z][a-z0-9_-]{0,79}$/.test(value.learning.scope),
        'Learning scope must be a bounded identifier',
      );
      learning.scope = value.learning.scope;
    }
    if (value.learning.python !== undefined)
      learning.python = localPath(value.learning.python, 'python');
    if (value.learning.upstream !== undefined)
      learning.upstream = localPath(value.learning.upstream, 'upstream');
    result.learning = learning;
  }
  return result;
}

export function configurationStatus(config: IntegrationConfig | null): IntegrationConfigStatus {
  const verified = config ? validateIntegrationConfig(config) : null;
  const evaluator = verified?.evaluator;
  const missing: string[] = (['endpoint', 'queue_dir', 'task_salt_file'] as const).filter(
    (key) => !evaluator?.[key],
  );
  if (evaluator?.reviewers !== undefined) {
    if (!evaluator.reviewers.length) missing.push('reviewers');
  } else {
    for (const key of ['client_id', 'reviewer_model', 'private_key_file'] as const)
      if (!evaluator?.[key]) missing.push(key);
  }
  const learningMissing = !verified?.learning
    ? ['learning']
    : verified.learning.reuse_enabled && !verified.learning.scope
      ? ['scope']
      : [];
  return {
    file: verified ? 'configured' : 'unconfigured',
    evaluator: {
      state: evaluator && missing.length === 0 ? 'configured' : 'unconfigured',
      profiles: evaluator?.endpoint ? 'configured' : 'unconfigured',
      local_feedback:
        evaluator?.queue_dir && evaluator.task_salt_file ? 'configured' : 'unconfigured',
      submission: evaluator && missing.length === 0 ? 'configured' : 'unconfigured',
      missing,
    },
    cost: {
      state: verified?.cost ? 'configured' : 'unconfigured',
      allowed: verified?.cost?.allow_api_equivalent ?? null,
      queue: evaluator?.queue_dir ? 'configured' : 'unconfigured',
    },
    learning: {
      state: learningMissing.length ? 'unconfigured' : 'configured',
      reuse_enabled: verified?.learning?.reuse_enabled ?? null,
      missing: learningMissing,
    },
    boundary: BOUNDARY,
  };
}

export function reviewerIdentityForModel(
  config: IntegrationConfig,
  actualReviewerModel: string,
): ReviewerIdentity | null {
  const verified = validateIntegrationConfig(config);
  const actual = label(actualReviewerModel, 'actual reviewer model');
  const evaluator = verified.evaluator;
  if (!evaluator) return null;
  if (evaluator.reviewers !== undefined)
    return evaluator.reviewers.find((reviewer) => reviewer.reviewer_model === actual) ?? null;
  if (evaluator.reviewer_model !== actual || !evaluator.client_id || !evaluator.private_key_file)
    return null;
  return {
    reviewer_model: evaluator.reviewer_model,
    client_id: evaluator.client_id,
    private_key_file: evaluator.private_key_file,
  };
}

async function parentsNoLinks(filename: string): Promise<void> {
  const parent = path.dirname(filename);
  const root = path.parse(parent).root;
  let current = root;
  const parts = path.relative(root, parent).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    check(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'Config parent must be a real directory without links',
    );
  }
}

function sameFile(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export async function loadIntegrationConfig(filename: string): Promise<IntegrationConfigResult> {
  const target = localPath(filename, 'Config file');
  try {
    await parentsNoLinks(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { config: null, status: configurationStatus(null) };
    throw error;
  }
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { config: null, status: configurationStatus(null) };
    throw error;
  }
  check(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 65536,
    'Config must be a bounded regular file without links',
  );
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    check(
      opened.isFile() && opened.nlink === 1 && sameFile(before, opened) && opened.size <= 65536,
      'Config changed while opening',
    );
    const bytes = await handle.readFile();
    check(bytes.byteLength <= 65536, 'Config exceeds the size limit');
    const after = await lstat(target);
    check(
      !after.isSymbolicLink() && after.isFile() && after.nlink === 1 && sameFile(opened, after),
      'Config changed while reading',
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('Invalid config JSON');
    }
    const config = validateIntegrationConfig(parsed);
    return { config, status: configurationStatus(config) };
  } finally {
    await handle.close();
  }
}

export async function createIntegrationConfig(
  filename: string,
  value: unknown,
): Promise<IntegrationConfigResult> {
  const target = localPath(filename, 'Config file');
  const config = validateIntegrationConfig(value);
  await parentsNoLinks(target);
  const handle = await open(target, 'wx', 0o600);
  try {
    const opened = await handle.stat();
    check(opened.isFile() && opened.nlink === 1, 'Config must be a new regular file without links');
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const after = await lstat(target);
    check(
      after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && sameFile(opened, after),
      'Config changed while creating',
    );
  } finally {
    await handle.close();
  }
  return { config, status: configurationStatus(config) };
}
