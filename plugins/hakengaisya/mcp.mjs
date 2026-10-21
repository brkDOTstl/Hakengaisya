import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { commands } from './runtime/lib/commands.mjs';

const manifest = JSON.parse(
  await readFile(new URL('./.codex-plugin/plugin.json', import.meta.url), 'utf8'),
);
const base = process.env.HAKENGAISYA_WORKSPACE
  ? path.resolve(process.env.HAKENGAISYA_WORKSPACE)
  : null;
const PREFIX = 'hakengaisya_';
const MAX_MESSAGE_BYTES = 262144;
export const tools = Object.entries(commands).map(([key, command]) => ({
  name: PREFIX + key,
  title: `Hakengaisya ${key.replaceAll('_', ' ')}`,
  description: command.description,
  inputSchema: command.inputSchema,
  annotations: {
    readOnlyHint: !command.writes,
    destructiveHint: false,
    idempotentHint: !command.writes,
    openWorldHint: false,
  },
}));

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function call(name, args) {
  const command =
    commands[typeof name === 'string' && name.startsWith(PREFIX) ? name.slice(PREFIX.length) : ''];
  if (!command) throw new Error(`Unknown Hakengaisya tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Tool arguments must be an object');
  return command.run(args, { base });
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
      serverInfo: { name: 'hakengaisya-workflow', version: manifest.version },
      instructions:
        'Local run controller for governed delegation. Tools validate briefs, plans and events and persist run state; they do not launch models, inspect artifacts or grant permissions. Use absolute run_file paths inside the task workspace' +
        (base ? ` (workspace base: ${base})` : '') +
        '. Read the company-workflow skill for the operating contract.',
    });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools });
  if (message.method === 'tools/call') {
    try {
      const value = await call(message.params?.name, message.params?.arguments ?? {});
      return result({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
        isError: false,
      });
    } catch (error) {
      return result({
        content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
        isError: true,
      });
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
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error('Message too large');
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
