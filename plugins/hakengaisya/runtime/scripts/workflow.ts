import { readFile } from 'node:fs/promises';
import { commands } from '../lib/commands.ts';
import type { FederationProject, HandoffRequest } from '../lib/federation.ts';
import { compileFederation, prepareHandoff, proposeReceiptImport } from '../lib/federation.ts';
import type { JevOptions } from '../lib/triage.ts';
import { triageWithJev } from '../lib/triage.ts';
import type { Run } from '../lib/types.ts';

const [command, target, source, extra] = process.argv.slice(2);
// Form files are untrusted JSON; the library validates every field it relies on.
const json = async <T = unknown>(filename: string): Promise<T> =>
  JSON.parse(await readFile(filename, 'utf8'));
const context = { base: process.cwd() };
const usage = [
  'presets',
  'preset-inspect <preset-id>',
  'preset-validate <preset.json>',
  'preset-select <request.json>',
  'preset-expand <preset-id> <request.json>',
  'harness2-job <run.json> <packet-id> [starting-harness.json]',
  'harness2-result <run.json> <job.json> <report.json>',
  'federation-plan <project.json>',
  'handoff <run.json> <project.json> <packet-id>',
  'receipt <run.json> <request.json> <receipt.json>',
  'organize <project.json> [phase]',
  'triage-request <intake.json>',
  'triage <intake.json> <response.json>',
  'triage-jev <approved-intake.json> <jev-options.json>',
  'select <brief.json>',
  'plan <brief.json> <workers.json>',
  'dispatch <run.json> <packet-id>',
  'review <run.json> <packet-id>',
  'agent-review <run.json>',
  'create <run.json> <brief.json>',
  'next <run.json>',
  'event <run.json> <event-or-events.json>',
];
try {
  let result: unknown;
  if (command === 'presets' && !target) result = await commands.presets_list.run({});
  else if (command === 'preset-inspect' && target && !source)
    result = await commands.preset_inspect.run({ preset_id: target });
  else if (command === 'preset-validate' && target && !source)
    result = await commands.preset_validate.run({ preset: await json(target) });
  else if (command === 'preset-select' && target && !source)
    result = await commands.preset_select.run({ request: await json(target) });
  else if (command === 'preset-expand' && target && source && !extra)
    result = await commands.preset_expand.run({ preset_id: target, request: await json(source) });
  else if (command === 'harness2-job' && target && source)
    result = await commands.optimizer_job.run(
      {
        run_file: target,
        packet_id: source,
        starting_harness: extra ? await json(extra) : undefined,
      },
      context,
    );
  else if (command === 'harness2-result' && target && source && extra)
    result = await commands.optimizer_result.run(
      { run_file: target, job: await json(source), report: await json(extra) },
      context,
    );
  else if (command === 'federation-plan' && target && !source)
    result = compileFederation(await json<FederationProject>(target));
  else if (command === 'handoff' && target && source && extra)
    result = prepareHandoff(await json<Run>(target), await json<FederationProject>(source), extra);
  else if (command === 'receipt' && target && source && extra)
    result = proposeReceiptImport(
      await json<Run>(target),
      await json<HandoffRequest>(source),
      await json(extra),
    );
  else if (command === 'organize' && target)
    result = await commands.organize.run({ project: await json(target), phase: source }, context);
  else if (command === 'triage-request' && target && !source)
    result = commands.triage_request.run({ intake: await json(target) }, context);
  else if (command === 'triage' && target && source)
    result = commands.triage.run(
      { intake: await json(target), response: await json(source) },
      context,
    );
  else if (command === 'triage-jev' && target && source)
    result = await triageWithJev(await json(target), await json<JevOptions>(source));
  else if (command === 'select' && target && !source)
    result = commands.select.run({ brief: await json(target) }, context);
  else if (command === 'plan' && target && source)
    result = commands.plan.run({ brief: await json(target), workers: await json(source) }, context);
  else if (command === 'dispatch' && target && source)
    result = await commands.dispatch.run({ run_file: target, packet_id: source }, context);
  else if (command === 'review' && target && source)
    result = await commands.review.run({ run_file: target, packet_id: source }, context);
  else if (command === 'create' && target && source)
    result = await commands.create_run.run(
      { run_file: target, brief: await json(source) },
      context,
    );
  else if (command === 'next' && target && !source)
    result = await commands.next.run({ run_file: target }, context);
  else if (command === 'agent-review' && target && !source)
    result = await commands.agent_review.run({ run_file: target }, context);
  else if (command === 'event' && target && source) {
    const events = await json(source);
    result = await commands.event.run(
      { run_file: target, events: Array.isArray(events) ? events : [events] },
      context,
    );
  } else throw new Error(`Usage: node scripts/workflow.ts ${usage.join(' | ')}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
