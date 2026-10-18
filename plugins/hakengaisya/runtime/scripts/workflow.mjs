import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chooseStructure, createRun, applyEvent, nextActions } from '../lib/workflow.mjs';
import { planWork } from '../lib/planning.mjs';
import { prepareTriage, finishTriage, triageWithJev } from '../lib/triage.mjs';
import { prepareDispatch, prepareReview } from '../lib/dispatch.mjs';
import { composeOrganization } from '../lib/organization.mjs';
import { compileFederation, prepareHandoff, proposeReceiptImport } from '../lib/federation.mjs';

const [command, target, source, extra] = process.argv.slice(2);
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
try {
  let result;
  if (command === 'federation-plan' && target && !source) result = compileFederation(await json(target));
  else if (command === 'handoff' && target && source && extra) result = prepareHandoff(await json(target), await json(source), extra);
  else if (command === 'receipt' && target && source && extra) result = proposeReceiptImport(await json(target), await json(source), await json(extra));
  else if (command === 'organize' && target) result = composeOrganization(await json(new URL('../config/organization-modules.json', import.meta.url)), await json(target), source);
  else if (command === 'triage-request' && target && !source) result = prepareTriage(await json(target));
  else if (command === 'triage' && target && source) result = finishTriage(await json(target), await json(source));
  else if (command === 'triage-jev' && target && source) result = await triageWithJev(await json(target), await json(source));
  else if (command === 'select' && target && !source) result = chooseStructure(await json(target));
  else if (command === 'plan' && target && source) result = planWork(await json(target), await json(source));
  else if (command === 'dispatch' && target && source) result = prepareDispatch(await json(target), source);
  else if (command === 'review' && target && source) result = prepareReview(await json(target), source);
  else if (command === 'create' && target && source) {
    const brief = await json(source); const selection = chooseStructure(brief);
    if (!selection.template_id) throw new Error('Direct mode does not create a company run');
    const template = selection.template_id === 'task-graph' ? null : await json(new URL(`../templates/${selection.template_id}.json`, import.meta.url));
    const run = createRun(template, brief);
    await writeFile(target, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' }); result = nextActions(run);
  } else if (command === 'next' && target && !source) result = nextActions(await json(target));
  else if (command === 'event' && target && source) {
    const filename = path.resolve(target); const lock = filename + '.lock';
    let handle;
    try { handle = await open(lock, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('Another writer holds the run lock; retry after it finishes. Inspect a crash before removing a stale lock.'); throw error; }
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      const updated = applyEvent(await json(filename), await json(source));
      await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, filename); result = nextActions(updated);
    } finally {
      await handle.close(); await unlink(lock);
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else throw new Error('Usage: node scripts/workflow.mjs federation-plan <project.json> | handoff <run.json> <project.json> <packet-id> | receipt <run.json> <request.json> <receipt.json> | organize <project.json> [phase] | triage-request <intake.json> | triage <intake.json> <response.json> | triage-jev <approved-intake.json> <jev-options.json> | select <brief.json> | plan <brief.json> <workers.json> | dispatch <run.json> <packet-id> | review <run.json> <packet-id> | create <run.json> <brief.json> | next <run.json> | event <run.json> <event.json>');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
