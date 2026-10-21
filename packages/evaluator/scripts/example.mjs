import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReport, submitReport } from '../sdk/client.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

export async function replayExample(store, baseUrl) {
  const fixture = JSON.parse(
    await readFile(new URL('../fixtures/local-history.json', import.meta.url), 'utf8'),
  );
  const keys = generateKeyPairSync('ed25519');
  const credentials = { clientId: 'local-example-agent', privateKey: keys.privateKey };
  // Unique local test credentials are held in memory, never written or printed.
  const clientId = `example-${randomBytes(12).toString('hex')}`;
  credentials.clientId = clientId;
  store.enroll({
    id: clientId,
    collection_id: 'example-collection',
    model: 'example-import-agent',
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  try {
    for (const example of fixture.examples) {
      const local = {
        ...example,
        reviewer_model: 'example-import-agent',
        local_task_identity: example.report_id.replace(/-v\d+$/, ''),
        evaluation_kind: 'historical_summary',
        relationship: 'indirect',
        attribution: 'model',
        usage: { input_tokens: null, output_tokens: null, cost_usd: null, wall_seconds: null },
      };
      const report = prepareReport(local, 'local-example-task-salt-not-a-production-secret');
      await submitReport(baseUrl, report, credentials);
    }
    const response = await fetch(`${baseUrl}/api/v1/profiles?kind=historical_summary`);
    const profiles = await response.json();
    if (!response.ok || profiles.profiles.length < fixture.examples.length)
      throw new Error('Historical example readback failed');
    return {
      accepted_reports: fixture.examples.length,
      skill_profiles: profiles.total,
      evaluation_kind: 'historical_summary',
      credentials_persisted: false,
      costs_invented: false,
    };
  } finally {
    store.disable(clientId);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.env.EVALUATOR_DATA_DIR ?? '.data');
  await mkdir(directory, { recursive: true });
  const registry = JSON.parse(
    await readFile(new URL('../fixtures/credibility-history.json', import.meta.url), 'utf8'),
  );
  const store = new Store(path.join(directory, 'evaluator.sqlite'), registry);
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    console.log(
      JSON.stringify(await replayExample(store, `http://127.0.0.1:${server.address().port}`)),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}
