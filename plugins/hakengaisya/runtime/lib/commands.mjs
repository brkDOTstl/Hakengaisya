import { chooseStructure, createRun, applyEvents, nextActions } from './workflow.mjs';
import { planWork } from './planning.mjs';
import { prepareTriage, finishTriage } from './triage.mjs';
import { prepareDispatch, prepareReview } from './dispatch.mjs';
import { composeOrganization } from './organization.mjs';
import { agentReview } from './participation.mjs';
import { readJson, readRun, createRunFile, updateRun, resolveRunFile } from './store.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const object = description => ({ type: 'object', description });
const schema = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });
const runFile = { type: 'string', description: 'Persisted run file (.json) inside the task workspace. Use an absolute path; a relative path needs a configured workspace base.' };
const packetId = { type: 'string', description: 'Packet identifier reported by next: work_<work_id>, or handover for the terminal delivery.' };
const brief = object('Task brief: run_id, objective, domain, lead_context, acceptance, constraints and task-first work_items (see the task-first forms). Optional planning_limits, workers, reporting_lines, dei, intake_triage, evidence_kind.');

export const loadTemplate = id => readJson(new URL('../templates/' + id + '.json', import.meta.url));
export const loadCatalog = () => readJson(new URL('../config/organization-modules.json', import.meta.url));

async function createPersistedRun(filename, input) {
  const selection = chooseStructure(input);
  check(selection.template_id, 'Direct mode does not create a company run');
  const template = selection.template_id === 'task-graph' ? null : await loadTemplate(selection.template_id);
  const run = createRun(template, input);
  await createRunFile(filename, run);
  return run;
}

export const commands = {
  triage_request: {
    description: 'Prepare the bounded intake-triage questionnaire for one short native-model call. Returns the fixed questions, state and input fingerprint; performs no classification itself.',
    inputSchema: schema(['intake'], { intake: object('Short intake: objective plus optional acceptance and constraints text arrays.') }),
    run: ({ intake }) => prepareTriage(intake)
  },
  triage: {
    description: 'Validate a triage response against its intake and derive the routing decision: direct, plan, escalate or out-of-scope. Confers no dispatch or signoff authority.',
    inputSchema: schema(['intake', 'response'], { intake: object('The same intake given to triage_request.'), response: object('Classifier response: input_fingerprint, answers {question: {choice, confidence}} and optional source {kind, model_id}.') }),
    run: ({ intake, response }) => finishTriage(intake, response)
  },
  select: {
    description: 'Select direct, compact or company structure for a brief from its deliverable dependencies and usable parallelism. Read-only; creates nothing.',
    inputSchema: schema(['brief'], { brief }),
    run: ({ brief: input }) => chooseStructure(input)
  },
  plan: {
    description: 'Estimate an adequate-route dispatch plan for a task-first brief over the supplied permitted workers. Reports needs-evidence or constraints-unmet instead of guessing; estimates are advice, not execution.',
    inputSchema: schema(['brief', 'workers'], { brief, workers: { type: 'array', description: 'Permitted execution routes with supported local profiles, availability, tools and optional context_id.', items: { type: 'object' } } }),
    run: ({ brief: input, workers }) => planWork(input, workers)
  },
  organize: {
    description: 'Compose an unbound organization proposal from capability modules for a project description and optional phase. Positions are roles, not launched agents.',
    inputSchema: schema(['project'], { project: object('Project description: id, objective, max_positions, max_active_agents, core_modules and optional optional_modules, phases, overrides and merges.'), phase: { type: 'string', description: 'Optional phase identifier declared in the project.' } }),
    run: async ({ project, phase }) => composeOrganization(await loadCatalog(), project, phase)
  },
  create_run: {
    description: 'Create a persisted run file from a brief and return its first next-actions snapshot. Refuses to overwrite an existing run; creates missing parent directories.',
    inputSchema: schema(['run_file', 'brief'], { run_file: runFile, brief }), writes: true,
    run: async ({ run_file, brief: input }, context) => { const filename = resolveRunFile(run_file, context?.base); const run = await createPersistedRun(filename, input); return { run_file: filename, ...nextActions(run) }; }
  },
  next: {
    description: 'Read the current run and return dispatchable, ready, reviewing, running and blocked packets with the completion flag. Read-only.',
    inputSchema: schema(['run_file'], { run_file: runFile }),
    run: async ({ run_file }, context) => { const filename = resolveRunFile(run_file, context?.base); return { run_file: filename, ...nextActions(await readRun(filename)) }; }
  },
  dispatch: {
    description: 'Prepare the bounded dispatch envelope for one assigned, dependency-ready packet: objective, inputs, outputs, checks, writes, binding and return contract. Read-only; the host launches the worker.',
    inputSchema: schema(['run_file', 'packet_id'], { run_file: runFile, packet_id: packetId }),
    run: async ({ run_file, packet_id }, context) => prepareDispatch(await readRun(resolveRunFile(run_file, context?.base)), packet_id)
  },
  review: {
    description: 'Prepare the review envelope for one submitted packet: current result, gate checks and, for handover, every user acceptance criterion. Read-only; the direct supervisor decides.',
    inputSchema: schema(['run_file', 'packet_id'], { run_file: runFile, packet_id: packetId }),
    run: async ({ run_file, packet_id }, context) => prepareReview(await readRun(resolveRunFile(run_file, context?.base)), packet_id)
  },
  event: {
    description: 'Apply one or more workflow events (assign, start, submit, review, block, resume, reopen) to the persisted run under a single-writer lock and return the next-actions snapshot. The batch is atomic: any invalid event leaves the file unchanged. The first event states expected_revision; later events in the batch may omit it.',
    inputSchema: schema(['run_file', 'events'], { run_file: runFile, events: { type: 'array', minItems: 1, description: 'Events in application order. Each needs id, packet_id, attempt, type and actor_context plus the fields of its type.', items: { type: 'object' } } }), writes: true,
    run: async ({ run_file, events }, context) => { const filename = resolveRunFile(run_file, context?.base); const updated = await updateRun(filename, run => applyEvents(run, events)); return { run_file: filename, ...nextActions(updated) }; }
  },
  agent_review: {
    description: 'Report the run-local management review: route candidate audit and optional DEI participation status. Read-only; not an evaluator upload.',
    inputSchema: schema(['run_file'], { run_file: runFile }),
    run: async ({ run_file }, context) => agentReview(await readRun(resolveRunFile(run_file, context?.base)))
  }
};
