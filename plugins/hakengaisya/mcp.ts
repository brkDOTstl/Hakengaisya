import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { type Command, commands } from './runtime/lib/commands.ts';

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown };
}

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const PREFIX = 'hakengaisya_';
const MAX_MESSAGE_BYTES = 262144;

const manifest: { version: string } = JSON.parse(
  await readFile(new URL('./.codex-plugin/plugin.json', import.meta.url), 'utf8'),
);
const base = process.env.HAKENGAISYA_WORKSPACE
  ? path.resolve(process.env.HAKENGAISYA_WORKSPACE)
  : null;

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

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function lookup(name: unknown): Command | undefined {
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return undefined;
  const key = name.slice(PREFIX.length);
  return Object.hasOwn(commands, key) ? commands[key] : undefined;
}

async function call(name: unknown, args: unknown): Promise<unknown> {
  const command = lookup(name);
  if (!command) throw new Error(`Unknown Hakengaisya tool: ${String(name)}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object');
  }
  return command.run(args as Record<string, unknown>, { base });
}

async function handle(message: JsonRpcRequest): Promise<void> {
  if (!Object.hasOwn(message, 'id')) return;
  const result = (value: unknown) => send({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    return result({
      protocolVersion:
        typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'hakengaisya-workflow', version: manifest.version },
      instructions: `Local run controller for governed delegation. Tools validate briefs, plans and events and persist run state; they do not launch models, inspect artifacts or grant permissions. Use absolute run_file paths inside the task workspace${base ? ` (workspace base: ${base})` : ''}. Read the company-workflow skill for the operating contract.`,
    });
  }
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
      const text = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
      return result({ content: [{ type: 'text', text }], isError: true });
    }
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not supported' },
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let chain = Promise.resolve();
lines.on('line', (line) => {
  chain = chain.then(async () => {
    if (!line.trim()) return;
    try {
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error('Message too large');
      const message: unknown = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('Not a JSON-RPC object');
      }
      await handle(message as JsonRpcRequest);
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON-RPC message' },
      });
    }
  });
});
