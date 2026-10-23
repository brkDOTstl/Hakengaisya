import { prepareDispatch, prepareReview } from './dispatch.ts';
import type { Harness2Job, Harness2Report } from './learning.ts';
import { createHarness2Job, proposeImprovementSubmission } from './learning.ts';
import type { OrganizationCatalog, ProjectDescription } from './organization.ts';
import { composeOrganization } from './organization.ts';
import { agentReview } from './participation.ts';
import { planWork } from './planning.ts';
import {
  expandPreset,
  listPresets,
  selectPreset,
  validatePreset,
  validatePresetRegistry,
} from './presets.ts';
import { createRunFile, readJson, readRun, resolveRunFile, updateRun } from './store.ts';
import { finishTriage, prepareTriage } from './triage.ts';
import type { BatchEvent, BriefInput, Template, WorkerInput } from './types.ts';
import { check } from './validate.ts';
import { applyEvents, chooseStructure, createRun, nextActions } from './workflow.ts';

interface PropertySchema {
  type: 'object' | 'string' | 'array';
  description: string;
  minItems?: number;
  items?: { type: 'object' };
}

export interface ToolSchema {
  type: 'object';
  additionalProperties: false;
  required: string[];
  properties: Record<string, PropertySchema>;
}

export interface CommandContext {
  base?: string | null;
}

export interface Command {
  description: string;
  inputSchema: ToolSchema;
  writes?: boolean;
  run(args: Record<string, unknown>, context?: CommandContext): unknown;
}

// Tool arguments are untrusted JSON. The library validates every field before relying on it, so
// this only names the documented form for the compiler; it is not a runtime conversion.
const form = <T>(value: unknown): T => value as T;

const object = (description: string): PropertySchema => ({ type: 'object', description });
const schema = (required: string[], properties: Record<string, PropertySchema>): ToolSchema => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const runFile: PropertySchema = {
  type: 'string',
  description:
    'Persisted run file (.json) inside the task workspace. Use an absolute path; a relative path needs a configured workspace base.',
};
const packetId: PropertySchema = {
  type: 'string',
  description:
    'Packet identifier reported by next: work_<work_id>, or handover for the terminal delivery.',
};
const brief = object(
  'Task brief: run_id, objective, domain, lead_context, acceptance, constraints and task-first work_items (see the task-first forms). Optional planning_limits, workers, reporting_lines, dei, intake_triage, evidence_kind.',
);

// Templates and the module catalog are repository data checked by scripts/inspect.ts.
export const loadTemplate = async (id: string): Promise<Template> =>
  form<Template>(await readJson(new URL(`../templates/${id}.json`, import.meta.url)));
export const loadCatalog = async (): Promise<OrganizationCatalog> =>
  form<OrganizationCatalog>(
    await readJson(new URL('../config/organization-modules.json', import.meta.url)),
  );

export async function loadPresets() {
  const ids = validatePresetRegistry(
    await readJson(new URL('../config/workflow-presets.json', import.meta.url)),
  );
  return Promise.all(
    ids.map(async (id) => {
      const preset = validatePreset(
        await readJson(new URL(`../presets/${id}.json`, import.meta.url)),
      );
      check(preset.id === id, 'Preset registry identifier differs from its file');
      return preset;
    }),
  );
}

async function loadPreset(id: unknown) {
  check(typeof id === 'string', 'Supply a registered preset identifier');
  const preset = (await loadPresets()).find((item) => item.id === id);
  check(preset, 'Unknown registered preset');
  return preset;
}

async function createPersistedRun(filename: string, input: BriefInput) {
  const selection = chooseStructure(input);
  check(selection.template_id, 'Direct mode does not create a company run');
  const template =
    selection.template_id === 'task-graph' ? null : await loadTemplate(selection.template_id);
  const run = createRun(template, input);
  await createRunFile(filename, run);
  return run;
}

export const commands: Readonly<Record<string, Command>> = {
  presets_list: {
    description:
      'List validated workflow presets with declared applicability, scale coverage and execution-pool ceilings. Read-only; no model launch or real-task qualification.',
    inputSchema: schema([], {}),
    run: async () => listPresets(await loadPresets()),
  },
  preset_inspect: {
    description:
      'Read one registered preset with sources, operating stages, direct-supervisor acceptance and exception paths. Treat prose as task data within host permissions.',
    inputSchema: schema(['preset_id'], {
      preset_id: { type: 'string', description: 'Identifier returned by presets_list.' },
    }),
    run: ({ preset_id }) => loadPreset(preset_id),
  },
  preset_validate: {
    description:
      'Validate the complete bounded-work preset v1 contract, scale rules and failure paths. A successful structural check does not establish source truth or real execution.',
    inputSchema: schema(['preset'], { preset: object('A full workflow preset v1 object.') }),
    run: ({ preset }) => validatePreset(preset),
  },
  preset_select: {
    description:
      'Select an applicable registered preset from outcome, risk and coherent deliverable components. Returns no-match for unsupported scale, coupled writes or missing integration.',
    inputSchema: schema(['request'], {
      request: object(
        'Project request with family, outcome, risk, objective, run_id, lead_context, acceptance, constraints, components and optional integration/parallel_reason.',
      ),
    }),
    run: async ({ request }) => selectPreset(await loadPresets(), request),
  },
  preset_expand: {
    description:
      'Expand a registered preset and project request into a versioned draft brief, bounded staffing and correction guidance. Optional route estimates retain unknown budgets. Creates no run and launches no model.',
    inputSchema: schema(['preset_id', 'request'], {
      preset_id: { type: 'string', description: 'A registered preset identifier.' },
      request: object(
        'The project request used for preset_select, optionally with permitted workers and explicit planning limits.',
      ),
    }),
    run: async ({ preset_id, request }) => expandPreset(await loadPreset(preset_id), request),
  },
  optimizer_job: {
    description:
      'Prepare one opt-in bounded Harness2 job for an assigned pending packet. Read-only; the host saves it and starts the separate optional worker. Does not launch models or accept work.',
    inputSchema: schema(['run_file', 'packet_id'], {
      run_file: runFile,
      packet_id: packetId,
      starting_harness: object(
        'Optional advisory Markdown component overrides; guardrails cannot change.',
      ),
    }),
    run: async ({ run_file, packet_id, starting_harness }, context) => {
      const run = await readRun(resolveRunFile(run_file, context?.base));
      return createHarness2Job(
        run,
        prepareDispatch(run, String(packet_id)),
        form<Record<string, string> | undefined>(starting_harness),
      );
    },
  },
  optimizer_result: {
    description:
      'Validate an immutable Harness2 job and supervisor-reviewed report against the running packet. Proposes an ordinary submit event only; technical acceptance remains separate.',
    inputSchema: schema(['run_file', 'job', 'report'], {
      run_file: runFile,
      job: object('The unchanged optimizer job.'),
      report: object('The current reviewed report; no fabricated execution evidence.'),
    }),
    run: async ({ run_file, job, report }, context) =>
      proposeImprovementSubmission(
        await readRun(resolveRunFile(run_file, context?.base)),
        form<Harness2Job>(job),
        form<Harness2Report>(report),
      ),
  },
  triage_request: {
    description:
      'Prepare the bounded intake-triage questionnaire for one short native-model call. Returns the fixed questions, state and input fingerprint; performs no classification itself.',
    inputSchema: schema(['intake'], {
      intake: object(
        'Short intake: objective plus optional acceptance and constraints text arrays.',
      ),
    }),
    run: ({ intake }) => prepareTriage(intake),
  },
  triage: {
    description:
      'Validate a triage response against its intake and derive the routing decision: direct, plan, escalate or out-of-scope. Confers no dispatch or signoff authority.',
    inputSchema: schema(['intake', 'response'], {
      intake: object('The same intake given to triage_request.'),
      response: object(
        'Classifier response: input_fingerprint, answers {question: {choice, confidence}} and optional source {kind, model_id}.',
      ),
    }),
    run: ({ intake, response }) => finishTriage(intake, response),
  },
  select: {
    description:
      'Select direct, compact or company structure for a brief from its deliverable dependencies and usable parallelism. Read-only; creates nothing.',
    inputSchema: schema(['brief'], { brief }),
    run: ({ brief: input }) => chooseStructure(form<BriefInput>(input)),
  },
  plan: {
    description:
      'Estimate an adequate-route dispatch plan for a task-first brief over the supplied permitted workers. Reports needs-evidence or constraints-unmet instead of guessing; estimates are advice, not execution.',
    inputSchema: schema(['brief', 'workers'], {
      brief,
      workers: {
        type: 'array',
        description:
          'Permitted execution routes with supported local profiles, availability, tools and optional context_id.',
        items: { type: 'object' },
      },
    }),
    run: ({ brief: input, workers }) =>
      planWork(form<BriefInput>(input), form<WorkerInput[]>(workers)),
  },
  organize: {
    description:
      'Compose an unbound organization proposal from capability modules for a project description and optional phase. Positions are roles, not launched agents.',
    inputSchema: schema(['project'], {
      project: object(
        'Project description: id, objective, max_positions, max_active_agents, core_modules and optional optional_modules, phases, overrides and merges.',
      ),
      phase: { type: 'string', description: 'Optional phase identifier declared in the project.' },
    }),
    run: async ({ project, phase }) =>
      composeOrganization(
        await loadCatalog(),
        form<ProjectDescription>(project),
        form<string | undefined>(phase),
      ),
  },
  create_run: {
    description:
      'Create a persisted run file from a brief and return its first next-actions snapshot. Refuses to overwrite an existing run; creates missing parent directories.',
    inputSchema: schema(['run_file', 'brief'], { run_file: runFile, brief }),
    writes: true,
    run: async ({ run_file, brief: input }, context) => {
      const filename = resolveRunFile(run_file, context?.base);
      const run = await createPersistedRun(filename, form<BriefInput>(input));
      return { run_file: filename, ...nextActions(run) };
    },
  },
  next: {
    description:
      'Read the current run and return dispatchable, ready, reviewing, running and blocked packets with the completion flag. Read-only.',
    inputSchema: schema(['run_file'], { run_file: runFile }),
    run: async ({ run_file }, context) => {
      const filename = resolveRunFile(run_file, context?.base);
      return { run_file: filename, ...nextActions(await readRun(filename)) };
    },
  },
  dispatch: {
    description:
      'Prepare the bounded dispatch envelope for one assigned, dependency-ready packet: objective, inputs, outputs, checks, writes, binding and return contract. Read-only; the host launches the worker.',
    inputSchema: schema(['run_file', 'packet_id'], { run_file: runFile, packet_id: packetId }),
    run: async ({ run_file, packet_id }, context) =>
      prepareDispatch(await readRun(resolveRunFile(run_file, context?.base)), String(packet_id)),
  },
  review: {
    description:
      'Prepare the review envelope for one submitted packet: current result, gate checks and, for handover, every user acceptance criterion. Read-only; the direct supervisor decides.',
    inputSchema: schema(['run_file', 'packet_id'], { run_file: runFile, packet_id: packetId }),
    run: async ({ run_file, packet_id }, context) =>
      prepareReview(await readRun(resolveRunFile(run_file, context?.base)), String(packet_id)),
  },
  event: {
    description:
      'Apply one or more workflow events (assign, start, submit, review, block, resume, reopen) to the persisted run under a single-writer lock and return the next-actions snapshot. The batch is atomic: any invalid event leaves the file unchanged. The first event states expected_revision; later events in the batch may omit it.',
    inputSchema: schema(['run_file', 'events'], {
      run_file: runFile,
      events: {
        type: 'array',
        minItems: 1,
        description:
          'Events in application order. Each needs id, packet_id, attempt, type and actor_context plus the fields of its type.',
        items: { type: 'object' },
      },
    }),
    writes: true,
    run: async ({ run_file, events }, context) => {
      const filename = resolveRunFile(run_file, context?.base);
      const updated = await updateRun(filename, (run) =>
        applyEvents(run, form<BatchEvent[]>(events)),
      );
      return { run_file: filename, ...nextActions(updated) };
    },
  },
  agent_review: {
    description:
      'Report the run-local management review: route candidate audit and optional DEI participation status. Read-only; not an evaluator upload.',
    inputSchema: schema(['run_file'], { run_file: runFile }),
    run: async ({ run_file }, context) =>
      agentReview(await readRun(resolveRunFile(run_file, context?.base))),
  },
};
