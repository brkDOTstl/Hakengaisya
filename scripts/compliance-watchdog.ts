import { readFile } from 'node:fs/promises';
import {
  type ComplianceWatchdogConfig,
  pollComplianceWatchdogOnce,
  runComplianceWatchdog,
} from '../lib/compliance-watchdog.ts';

const USAGE = [
  'Usage: node scripts/compliance-watchdog.ts --run <absolute-run.json> --state-dir <absolute-dir> [options]',
  'Options:',
  '  --config <watchdog.json>      Load base config JSON (CLI flags override file fields)',
  '  --once                        Run one poll/check cycle and exit',
  '  --emit-only                   Write wake packet JSON only (default when --wake-cmd omitted)',
  '  --wake-cmd <executable>       Explicit local executable to invoke when wake triggers',
  '  --wake-arg <arg>              Repeatable argument for --wake-cmd (supports {audit_file}, {run_file}, {monitor_context}, {revision}, {reasons})',
  '  --poll-ms <ms>                Poll interval in continuous mode (default 3000)',
  '  --cooldown-seconds <sec>      Minimum seconds between wakes (default 30)',
  '  --max-wakes <n>               Hard ceiling on wakes per run (default 20, max 200)',
  '  --wake-timeout-seconds <sec>  Per-invocation timeout (default 300)',
  '  --retain <n>                  Number of recent wake packet files to keep (default 3)',
  '  --force                       Force a wake check (for host lifecycle hooks)',
  '  --reason <text>               Hook reason label when --force is set',
  '  --exit-nonzero-on-wake        With --once, exit 2 when woken or cap-reached',
].join('\n');

async function parseArgs(argv: string[]): Promise<{
  config: ComplianceWatchdogConfig;
  once: boolean;
  exitNonzeroOnWake: boolean;
}> {
  let configPath: string | null = null;
  let runFile: string | undefined;
  let stateDir: string | undefined;
  let wakeExecutable: string | undefined;
  const wakeArgs: string[] = [];
  let emitOnly = false;
  let once = false;
  let exitNonzeroOnWake = false;
  let pollMs: number | undefined;
  let cooldownSeconds: number | undefined;
  let maxWakes: number | undefined;
  let wakeTimeoutSeconds: number | undefined;
  let retainWakeFiles: number | undefined;
  let force = false;
  let hookReason: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--config') configPath = next();
    else if (arg === '--run') runFile = next();
    else if (arg === '--state-dir') stateDir = next();
    else if (arg === '--wake-cmd') wakeExecutable = next();
    else if (arg === '--wake-arg') wakeArgs.push(next());
    else if (arg === '--emit-only') emitOnly = true;
    else if (arg === '--once') once = true;
    else if (arg === '--exit-nonzero-on-wake') exitNonzeroOnWake = true;
    else if (arg === '--poll-ms') pollMs = Number(next());
    else if (arg === '--cooldown-seconds') cooldownSeconds = Number(next());
    else if (arg === '--max-wakes') maxWakes = Number(next());
    else if (arg === '--wake-timeout-seconds') wakeTimeoutSeconds = Number(next());
    else if (arg === '--retain') retainWakeFiles = Number(next());
    else if (arg === '--force') force = true;
    else if (arg === '--reason') hookReason = next();
    else if (arg === '--') {
      const rest = argv.slice(i + 1);
      if (rest.length === 0) throw new Error('Supply an executable after --');
      wakeExecutable = rest[0];
      wakeArgs.push(...rest.slice(1));
      break;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const base: Partial<ComplianceWatchdogConfig> = configPath
    ? (JSON.parse(await readFile(configPath, 'utf8')) as Partial<ComplianceWatchdogConfig>)
    : {};

  if (emitOnly && wakeExecutable) {
    throw new Error('Cannot combine --emit-only with --wake-cmd');
  }

  const config: ComplianceWatchdogConfig = {
    ...base,
    run_file: runFile ?? base.run_file ?? '',
    state_dir: stateDir ?? base.state_dir ?? '',
    ...(emitOnly
      ? { wake_command: undefined }
      : wakeExecutable
        ? { wake_command: [wakeExecutable, ...wakeArgs] }
        : {}),
    ...(pollMs !== undefined ? { poll_interval_ms: pollMs } : {}),
    ...(cooldownSeconds !== undefined ? { cooldown_seconds: cooldownSeconds } : {}),
    ...(maxWakes !== undefined ? { max_wakes: maxWakes } : {}),
    ...(wakeTimeoutSeconds !== undefined ? { wake_timeout_seconds: wakeTimeoutSeconds } : {}),
    ...(retainWakeFiles !== undefined ? { retain_wake_files: retainWakeFiles } : {}),
    ...(force ? { force: true } : {}),
    ...(hookReason !== undefined ? { hook_reason: hookReason } : {}),
  };

  return { config, once, exitNonzeroOnWake };
}

try {
  const { config, once, exitNonzeroOnWake } = await parseArgs(process.argv.slice(2));
  if (once) {
    const outcome = await pollComplianceWatchdogOnce(config);
    console.log(JSON.stringify(outcome, null, 2));
    if (exitNonzeroOnWake && (outcome.action === 'woken' || outcome.action === 'cap-reached')) {
      process.exitCode = 2;
    }
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await runComplianceWatchdog(config, {
      signal: controller.signal,
      onEvent: (outcome) => {
        if (outcome.action !== 'idle' && outcome.action !== 'skipped-duplicate') {
          console.log(JSON.stringify(outcome));
        }
      },
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
