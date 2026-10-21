import { createInterface } from 'node:readline';
import { Recorder } from './recorder.mjs';
import { DIMENSIONS, SKILLS, TASK_TYPES } from './runtime/src/contract.mjs';

const recorder = new Recorder();
const ratingProperties = Object.fromEntries(
  DIMENSIONS.map((dimension) => [
    dimension,
    {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 10,
      description: `Observed ${dimension} score; null if not observed.`,
    },
  ]),
);
export const tool = {
  name: 'record_evaluation',
  title: 'Record peer AI skill evaluation',
  description:
    'After observing or reviewing another AI model on a technical task, fill this small record once. The local recorder saves and signs it, uploads automatically, and queues it if offline. No separate model call is made. Use de-identified English comments; never invent scores or costs. This is skill guidance, independent of task dispatch or company topology.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'subject_model',
      'task_type',
      'difficulty',
      'tags',
      'ratings',
      'comment',
      'example',
      'guidance',
    ],
    properties: {
      subject_model: {
        type: 'string',
        description: 'Exact model label of the observed peer; never yourself.',
      },
      task_type: { type: 'string', enum: TASK_TYPES },
      difficulty: { type: 'string', enum: ['routine', 'standard', 'complex'] },
      tags: {
        type: 'array',
        items: { type: 'string', enum: SKILLS },
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
      },
      ratings: {
        type: 'object',
        additionalProperties: false,
        properties: ratingProperties,
        description:
          'D1 evidence; D2 changes; D3 diagnosis; D4 review; D5 effective speed; D6 reliability/coordination.',
      },
      comment: { type: 'string', maxLength: 1200 },
      example: { type: 'string', maxLength: 1200 },
      guidance: { type: 'string', maxLength: 1200 },
      task_ref: {
        type: 'string',
        description:
          'Stable opaque local task reference for retries; only a salted token is uploaded.',
      },
      record_id: {
        type: 'string',
        description: 'Reuse for a retry of the same record; omit for a new record.',
      },
      domain: { type: 'string', enum: ['software-engineering', 'technical-product'] },
      route: { type: 'string' },
      effort: { type: 'string' },
      evaluation_kind: { type: 'string', enum: ['local_work', 'simulation', 'historical_summary'] },
      relationship: { type: 'string', enum: ['direct', 'review', 'indirect'] },
      attribution: {
        type: 'string',
        enum: ['model', 'route', 'environment', 'specification', 'unknown'],
      },
      usage: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          ['input_tokens', 'output_tokens', 'cost_usd', 'wall_seconds'].map((key) => [
            key,
            { type: ['number', 'null'], minimum: 0 },
          ]),
        ),
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function handle(message) {
  if (!Object.hasOwn(message, 'id')) return;
  const result = (value) => send({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize')
    return result({
      protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(
        message.params?.protocolVersion,
      )
        ? message.params.protocolVersion
        : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'hakengaisya-evaluator-recorder', version: '0.2.0' },
      instructions:
        'Use record_evaluation after observed peer-model technical work. Fill the form directly. This recorder does not invoke models or design workflows. A one-time configured connection is required.',
    });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools: [tool] });
  if (message.method === 'tools/call') {
    try {
      if (message.params?.name !== tool.name) throw new Error('Unknown recorder tool');
      const receipt = await recorder.record(message.params.arguments);
      return result({
        content: [{ type: 'text', text: JSON.stringify(receipt) }],
        isError: receipt.status === 'rejected',
      });
    } catch (error) {
      return result({ content: [{ type: 'text', text: error.message }], isError: true });
    }
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not supported' },
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
lines.on('line', (line) => {
  chain = chain.then(async () => {
    if (!line.trim()) return;
    try {
      if (Buffer.byteLength(line) > 32768) throw new Error('Message too large');
      await handle(JSON.parse(line));
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON-RPC message' },
      });
    }
  });
});
