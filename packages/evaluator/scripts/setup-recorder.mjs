import { mkdir, access, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assert, identifier } from '../src/contract.mjs';
import { Store } from '../src/store.mjs';

const args = process.argv.slice(2); const options = {};
for (let index = 0; index < args.length; index += 2) {
  assert(['--home', '--reviewer-model', '--server-url', '--enroll-local'].includes(args[index]) && args[index + 1], 'Usage: node scripts/setup-recorder.mjs --home <private-data-directory> --reviewer-model <host-model-id> [--server-url <origin>] [--enroll-local <database>]');
  assert(!Object.hasOwn(options, args[index]), 'Repeated setup option'); options[args[index]] = args[index + 1];
}
assert(options['--home'] && options['--reviewer-model'], 'Provide a recorder home and actual host model identity'); identifier(options['--reviewer-model']);
const home = path.resolve(options['--home']);
try { await access(path.join(home, 'connection.json')); throw new Error('Recorder already configured; existing keys were preserved.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const serverUrl = new URL(options['--server-url'] ?? 'http://127.0.0.1:4317');
assert(!serverUrl.username && !serverUrl.password && !serverUrl.search && !serverUrl.hash && serverUrl.pathname === '/', 'Use a clean service origin');
assert(serverUrl.protocol === 'https:' || (serverUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(serverUrl.hostname)), 'Remote service requires HTTPS');
const keys = generateKeyPairSync('ed25519');
const clientId = 'recorder-' + randomUUID(); const collectionId = 'installation-' + randomUUID();
const config = { version: 1, server_url: serverUrl.origin, client_id: clientId, reviewer_model: options['--reviewer-model'] };
await mkdir(home, { recursive: true, mode: 0o700 });
await writeFile(path.join(home, 'agent.key'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
await writeFile(path.join(home, 'task-salt'), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
await writeFile(path.join(home, 'agent-public.json'), JSON.stringify({ id: clientId, collection_id: collectionId, model: config.reviewer_model, public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (options['--enroll-local']) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(serverUrl.hostname), 'Local enrollment is only for a loopback service');
  await access(path.resolve(options['--enroll-local']));
  const store = new Store(path.resolve(options['--enroll-local']));
  try { store.enroll({ id: clientId, collection_id: collectionId, model: config.reviewer_model, public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) }); } finally { store.close(); }
}
await writeFile(path.join(home, 'connection.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ configured: true, enrolled_locally: Boolean(options['--enroll-local']), reviewer_model: config.reviewer_model, server_url: config.server_url, private_material_printed: false }));
