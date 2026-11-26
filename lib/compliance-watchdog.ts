import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { type ComplianceWakeStatus, evaluateComplianceWake } from './compliance-monitor.ts';
import { readRun } from './store.ts';
import { check, isRecord, requireText } from './validate.ts';
import { nextActions } from './workflow.ts';

const DEFAULT_POLL_MS = 3000;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 300_000;
const DEFAULT_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 86_400;
const DEFAULT_MAX_WAKES = 20;
const HARD_MAX_WAKES = 200;
const DEFAULT_WAKE_TIMEOUT_SECONDS = 300;
const HARD_WAKE_TIMEOUT_SECONDS = 1800;
const DEFAULT_RETAIN_WAKE_FILES = 3;
const HARD_RETAIN_WAKE_FILES = 20;
const MAX_HISTORY_ENTRIES = 20;
const MAX_OUTPUT_CHARS = 4096;

export interface WakeInvocationResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout_excerpt: string;
  stderr_excerpt: string;
  error?: string;
}

export type WakeInvoker = (
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<WakeInvocationResult>;

export interface ComplianceWatchdogConfig {
  run_file: string;
  state_dir: string;
  wake_command?: string[];
  poll_interval_ms?: number;
  cooldown_seconds?: number;
  max_wakes?: number;
  wake_timeout_seconds?: number;
  retain_wake_files?: number;
  force?: boolean;
  hook_reason?: string;
  now?: () => Date;
  invoke?: WakeInvoker;
}

export interface WatchdogHistoryEntry {
  wake_number: number;
  woken_at: string;
  revision: number;
  trigger_fingerprint: string;
  reasons: string[];
  audit_file: string;
  mode: 'emit-only' | 'command';
  exit_code?: number | null;
  timed_out?: boolean;
  error?: string;
}

export interface WatchdogPersistedState {
  version: 1;
  run_file: string;
  wakes_issued: number;
  last_wake_at: string | null;
  last_woken_fingerprint: string | null;
  history: WatchdogHistoryEntry[];
}

export type WatchdogPollOutcome =
  | {
      action: 'idle' | 'complete' | 'skipped-duplicate' | 'skipped-cooldown' | 'cap-reached';
      reason: string;
      run_file: string;
      revision: number;
      wakes_issued: number;
      remaining_cooldown_seconds?: number;
      trigger_fingerprint?: string | null;
      wake?: ComplianceWakeStatus;
    }
  | {
      action: 'woken';
      mode: 'emit-only' | 'command';
      run_file: string;
      revision: number;
      wake_number: number;
      wakes_issued: number;
      monitor_context: string;
      trigger_fingerprint: string;
      reasons: string[];
      audit_file: string;
      retained_wake_files: number;
      invocation?: WakeInvocationResult;
    };

export interface NormalizedWatchdogConfig {
  run_file: string;
  state_dir: string;
  wake_command: string[] | null;
  poll_interval_ms: number;
  cooldown_seconds: number;
  max_wakes: number;
  wake_timeout_seconds: number;
  retain_wake_files: number;
  force: boolean;
  hook_reason?: string;
  now: () => Date;
  invoke: WakeInvoker;
}

export const invokeWakeCommand: WakeInvoker = async (argv, env, timeoutMs) => {
  const [executable, ...args] = argv;
  const { promise, resolve } = Promise.withResolvers<WakeInvocationResult>();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const finish = (result: WakeInvocationResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const child = spawn(executable, args, {
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < MAX_OUTPUT_CHARS) {
      stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT_CHARS - stdout.length);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_OUTPUT_CHARS) {
      stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT_CHARS - stderr.length);
    }
  });
  child.once('error', (error) => {
    finish({
      exit_code: null,
      signal: null,
      timed_out: timedOut,
      stdout_excerpt: stdout.trim(),
      stderr_excerpt: stderr.trim(),
      error: error.message,
    });
  });
  child.once('close', (code, signal) => {
    finish({
      exit_code: code,
      signal: signal ?? null,
      timed_out: timedOut,
      stdout_excerpt: stdout.trim(),
      stderr_excerpt: stderr.trim(),
    });
  });
  return promise;
};

export function normalizeWatchdogConfig(raw: ComplianceWatchdogConfig): NormalizedWatchdogConfig {
  check(isRecord(raw), 'Supply a compliance watchdog configuration object');
  requireText(raw.run_file, 'Watchdog run_file');
  check(path.isAbsolute(raw.run_file), 'Watchdog run_file must be an absolute path');
  requireText(raw.state_dir, 'Watchdog state_dir');
  check(path.isAbsolute(raw.state_dir), 'Watchdog state_dir must be an absolute path');

  let wakeCommand: string[] | null = null;
  if (raw.wake_command !== undefined) {
    check(
      Array.isArray(raw.wake_command) &&
        raw.wake_command.length > 0 &&
        raw.wake_command.every((part) => typeof part === 'string' && part.length > 0),
      'Watchdog wake_command must be a non-empty argv array of nonempty strings',
    );
    requireText(raw.wake_command[0], 'Watchdog wake_command executable');
    wakeCommand = [...raw.wake_command];
  }

  const pollIntervalMs = raw.poll_interval_ms ?? DEFAULT_POLL_MS;
  check(
    typeof pollIntervalMs === 'number' &&
      Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs >= MIN_POLL_MS &&
      pollIntervalMs <= MAX_POLL_MS,
    `poll_interval_ms must be an integer between ${MIN_POLL_MS} and ${MAX_POLL_MS}`,
  );

  const cooldownSeconds = raw.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS;
  check(
    typeof cooldownSeconds === 'number' &&
      Number.isFinite(cooldownSeconds) &&
      cooldownSeconds >= 0 &&
      cooldownSeconds <= MAX_COOLDOWN_SECONDS,
    `cooldown_seconds must be between 0 and ${MAX_COOLDOWN_SECONDS}`,
  );

  const maxWakes = raw.max_wakes ?? DEFAULT_MAX_WAKES;
  check(
    typeof maxWakes === 'number' &&
      Number.isSafeInteger(maxWakes) &&
      maxWakes >= 1 &&
      maxWakes <= HARD_MAX_WAKES,
    `max_wakes must be an integer between 1 and ${HARD_MAX_WAKES}`,
  );

  const wakeTimeoutSeconds = raw.wake_timeout_seconds ?? DEFAULT_WAKE_TIMEOUT_SECONDS;
  check(
    typeof wakeTimeoutSeconds === 'number' &&
      Number.isSafeInteger(wakeTimeoutSeconds) &&
      wakeTimeoutSeconds >= 1 &&
      wakeTimeoutSeconds <= HARD_WAKE_TIMEOUT_SECONDS,
    `wake_timeout_seconds must be an integer between 1 and ${HARD_WAKE_TIMEOUT_SECONDS}`,
  );

  const retainWakeFiles = raw.retain_wake_files ?? DEFAULT_RETAIN_WAKE_FILES;
  check(
    typeof retainWakeFiles === 'number' &&
      Number.isSafeInteger(retainWakeFiles) &&
      retainWakeFiles >= 1 &&
      retainWakeFiles <= HARD_RETAIN_WAKE_FILES,
    `retain_wake_files must be an integer between 1 and ${HARD_RETAIN_WAKE_FILES}`,
  );

  return {
    run_file: path.resolve(raw.run_file),
    state_dir: path.resolve(raw.state_dir),
    wake_command: wakeCommand,
    poll_interval_ms: pollIntervalMs,
    cooldown_seconds: cooldownSeconds,
    max_wakes: maxWakes,
    wake_timeout_seconds: wakeTimeoutSeconds,
    retain_wake_files: retainWakeFiles,
    force: Boolean(raw.force),
    ...(raw.hook_reason ? { hook_reason: raw.hook_reason } : {}),
    now: raw.now ?? (() => new Date()),
    invoke: raw.invoke ?? invokeWakeCommand,
  };
}

async function ensureStateDir(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(stateDir);
  check(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Watchdog state_dir must be a real directory, not a symbolic link',
  );
  return realpath(stateDir);
}

async function acquireLock(stateDir: string, runFile: string): Promise<string> {
  const lockPath = path.join(stateDir, 'watchdog.lock');
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(
          { pid: process.pid, started_at: new Date().toISOString(), run_file: runFile },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
    return lockPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Another compliance watchdog or stale lock exists (${lockPath}); inspect it before retrying`,
      );
    }
    throw error;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function loadState(stateDir: string, runFile: string): Promise<WatchdogPersistedState> {
  const statePath = path.join(stateDir, 'watchdog-state.json');
  try {
    const stat = await lstat(statePath);
    check(stat.isFile() && !stat.isSymbolicLink(), 'Watchdog state file must be a regular file');
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    check(
      isRecord(parsed) &&
        parsed.version === 1 &&
        typeof parsed.wakes_issued === 'number' &&
        Array.isArray(parsed.history),
      'Invalid watchdog state file',
    );
    return parsed as unknown as WatchdogPersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        version: 1,
        run_file: runFile,
        wakes_issued: 0,
        last_wake_at: null,
        last_woken_fingerprint: null,
        history: [],
      };
    }
    throw error;
  }
}

async function saveState(stateDir: string, state: WatchdogPersistedState): Promise<void> {
  const statePath = path.join(stateDir, 'watchdog-state.json');
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, statePath);
}

async function pruneWakeFiles(stateDir: string, retain: number): Promise<number> {
  const entries = (await readdir(stateDir))
    .filter((name) => /^wake-\d{4}-rev\d+-[a-f0-9]{8}\.json$/.test(name))
    .sort();
  const excess = entries.length - retain;
  for (let i = 0; i < excess; i += 1) {
    await unlink(path.join(stateDir, entries[i]));
  }
  return Math.min(entries.length, retain);
}

function expandWakeArgv(template: string[], vars: Record<string, string>): string[] {
  return template.map((part, index) => {
    if (index === 0) return part;
    let expanded = part;
    for (const [key, value] of Object.entries(vars)) {
      expanded = expanded.replaceAll(`{${key}}`, value);
    }
    return expanded;
  });
}

async function evaluateAndMaybeWake(
  config: NormalizedWatchdogConfig,
  resolvedStateDir: string,
): Promise<WatchdogPollOutcome> {
  const run = await readRun(config.run_file);
  const state = await loadState(resolvedStateDir, config.run_file);

  if (!run.compliance_monitor?.enabled) {
    return {
      action: 'idle',
      reason: 'compliance-monitor-disabled',
      run_file: config.run_file,
      revision: run.revision,
      wakes_issued: state.wakes_issued,
    };
  }
  if (nextActions(run).complete) {
    return {
      action: 'complete',
      reason: 'run-complete',
      run_file: config.run_file,
      revision: run.revision,
      wakes_issued: state.wakes_issued,
    };
  }

  const nowDate = config.now();
  const nowIso = nowDate.toISOString();
  const wake = evaluateComplianceWake(run, {
    now: nowIso,
    force: config.force,
    hook_reason: config.hook_reason,
    include_audit_packet: true,
  });

  if (!wake.wake_required || !wake.trigger_fingerprint || !wake.monitor_context) {
    return {
      action: 'idle',
      reason: 'no-trigger',
      run_file: config.run_file,
      revision: run.revision,
      wakes_issued: state.wakes_issued,
      wake,
    };
  }

  if (state.last_woken_fingerprint === wake.trigger_fingerprint) {
    return {
      action: 'skipped-duplicate',
      reason: 'already-woken-for-fingerprint',
      run_file: config.run_file,
      revision: run.revision,
      wakes_issued: state.wakes_issued,
      trigger_fingerprint: wake.trigger_fingerprint,
    };
  }

  if (state.wakes_issued >= config.max_wakes) {
    return {
      action: 'cap-reached',
      reason: `max-wakes-reached (${config.max_wakes})`,
      run_file: config.run_file,
      revision: run.revision,
      wakes_issued: state.wakes_issued,
      trigger_fingerprint: wake.trigger_fingerprint,
    };
  }

  if (state.last_wake_at && config.cooldown_seconds > 0) {
    const elapsedSeconds = (nowDate.getTime() - Date.parse(state.last_wake_at)) / 1000;
    if (Number.isFinite(elapsedSeconds) && elapsedSeconds < config.cooldown_seconds) {
      return {
        action: 'skipped-cooldown',
        reason: 'cooldown-active',
        run_file: config.run_file,
        revision: run.revision,
        wakes_issued: state.wakes_issued,
        remaining_cooldown_seconds: Math.ceil(config.cooldown_seconds - elapsedSeconds),
        trigger_fingerprint: wake.trigger_fingerprint,
      };
    }
  }

  const wakeNumber = state.wakes_issued + 1;
  const filename = `wake-${String(wakeNumber).padStart(4, '0')}-rev${run.revision}-${wake.trigger_fingerprint.slice(0, 8)}.json`;
  const auditFile = path.join(resolvedStateDir, filename);
  const reasonCodes = wake.reasons.map((item) => item.code);

  const payload = {
    version: 1,
    kind: 'hakengaisya-compliance-wake',
    wake_number: wakeNumber,
    created_at: nowIso,
    run_file: config.run_file,
    revision: run.revision,
    trigger_fingerprint: wake.trigger_fingerprint,
    monitor_context: wake.monitor_context,
    reasons: wake.reasons,
    counters: wake.counters,
    audit_packet: wake.audit_packet,
    recommended_action: wake.recommended_action,
  };
  await writeFile(auditFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  const retained = await pruneWakeFiles(resolvedStateDir, config.retain_wake_files);

  const mode: 'emit-only' | 'command' = config.wake_command ? 'command' : 'emit-only';
  let invocation: WakeInvocationResult | undefined;
  if (config.wake_command) {
    const vars = {
      audit_file: auditFile,
      run_file: config.run_file,
      monitor_context: wake.monitor_context,
      revision: String(run.revision),
      reasons: reasonCodes.join(','),
      trigger_fingerprint: wake.trigger_fingerprint,
    };
    const argv = expandWakeArgv(config.wake_command, vars);
    const env = {
      HAKENGAISYA_RUN_FILE: config.run_file,
      HAKENGAISYA_AUDIT_FILE: auditFile,
      HAKENGAISYA_MONITOR_CONTEXT: wake.monitor_context,
      HAKENGAISYA_RUN_REVISION: String(run.revision),
      HAKENGAISYA_WAKE_REASONS: reasonCodes.join(','),
      HAKENGAISYA_WAKE_FINGERPRINT: wake.trigger_fingerprint,
    };
    invocation = await config.invoke(argv, env, config.wake_timeout_seconds * 1000);
  }

  const historyEntry: WatchdogHistoryEntry = {
    wake_number: wakeNumber,
    woken_at: nowIso,
    revision: run.revision,
    trigger_fingerprint: wake.trigger_fingerprint,
    reasons: reasonCodes,
    audit_file: auditFile,
    mode,
    ...(invocation
      ? {
          exit_code: invocation.exit_code,
          timed_out: invocation.timed_out,
          ...(invocation.error ? { error: invocation.error } : {}),
        }
      : {}),
  };
  const nextState: WatchdogPersistedState = {
    version: 1,
    run_file: config.run_file,
    wakes_issued: wakeNumber,
    last_wake_at: nowIso,
    last_woken_fingerprint: wake.trigger_fingerprint,
    history: [...state.history, historyEntry].slice(-MAX_HISTORY_ENTRIES),
  };
  await saveState(resolvedStateDir, nextState);

  return {
    action: 'woken',
    mode,
    run_file: config.run_file,
    revision: run.revision,
    wake_number: wakeNumber,
    wakes_issued: wakeNumber,
    monitor_context: wake.monitor_context,
    trigger_fingerprint: wake.trigger_fingerprint,
    reasons: reasonCodes,
    audit_file: auditFile,
    retained_wake_files: retained,
    ...(invocation ? { invocation } : {}),
  };
}

export async function pollComplianceWatchdogOnce(
  rawConfig: ComplianceWatchdogConfig,
): Promise<WatchdogPollOutcome> {
  const config = normalizeWatchdogConfig(rawConfig);
  const resolvedStateDir = await ensureStateDir(config.state_dir);
  const lockPath = await acquireLock(resolvedStateDir, config.run_file);
  try {
    return await evaluateAndMaybeWake(config, resolvedStateDir);
  } finally {
    await releaseLock(lockPath);
  }
}

export async function runComplianceWatchdog(
  rawConfig: ComplianceWatchdogConfig,
  options: {
    signal?: AbortSignal;
    onEvent?: (outcome: WatchdogPollOutcome) => void;
    max_polls?: number;
  } = {},
): Promise<WatchdogPollOutcome> {
  const config = normalizeWatchdogConfig(rawConfig);
  const resolvedStateDir = await ensureStateDir(config.state_dir);
  const lockPath = await acquireLock(resolvedStateDir, config.run_file);
  let polls = 0;
  let lastOutcome: WatchdogPollOutcome = {
    action: 'idle',
    reason: 'aborted-before-poll',
    run_file: config.run_file,
    revision: 0,
    wakes_issued: 0,
  };
  try {
    while (!options.signal?.aborted) {
      lastOutcome = await evaluateAndMaybeWake(config, resolvedStateDir);
      options.onEvent?.(lastOutcome);
      polls += 1;
      if (
        lastOutcome.action === 'complete' ||
        lastOutcome.action === 'cap-reached' ||
        (options.max_polls !== undefined && polls >= options.max_polls)
      ) {
        return lastOutcome;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, config.poll_interval_ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      await promise;
    }
    return lastOutcome;
  } finally {
    await releaseLock(lockPath);
  }
}
