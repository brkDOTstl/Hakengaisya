import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  configurationStatus,
  createIntegrationConfig,
  loadIntegrationConfig,
  reviewerIdentityForModel,
  validateIntegrationConfig,
} from '../lib/integration-config.ts';

async function temporary(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hak-integration-config-'));
  const files: string[] = [];
  const directories: string[] = [];
  t.after(async () => {
    for (const file of files.reverse()) await unlink(file);
    for (const dir of directories.reverse()) await rmdir(dir);
    await rmdir(directory);
  });
  return {
    directory,
    file: (name: string) => {
      const filename = path.join(directory, name);
      files.push(filename);
      return filename;
    },
    subdirectory: async (name: string) => {
      const filename = path.join(directory, name);
      await mkdir(filename);
      directories.push(filename);
      return filename;
    },
  };
}

test('creates once and loads a non-secret config without creating dependencies', async (t) => {
  const tmp = await temporary(t);
  const filename = tmp.file('integration.json');
  const value = {
    version: 1,
    evaluator: {
      endpoint: 'http://127.0.0.1:4317/',
      queue_dir: path.join(tmp.directory, 'queue'),
      task_salt_file: path.join(tmp.directory, 'salt'),
      client_id: 'client-1',
      reviewer_model: 'gpt-6.1-sol',
      private_key_file: path.join(tmp.directory, 'agent.key'),
    },
    cost: { allow_api_equivalent: true, max_age_days: 60, task_token_scope: 'a'.repeat(64) },
    learning: {
      state_dir: path.join(tmp.directory, 'learning'),
      reuse_enabled: true,
      scope: 'project_1',
      python: path.join(tmp.directory, 'python.exe'),
      upstream: path.join(tmp.directory, 'upstream'),
    },
  };
  const created = await createIntegrationConfig(filename, value);
  assert.equal(created.status.evaluator.state, 'configured');
  assert.equal(created.status.evaluator.profiles, 'configured');
  assert.equal(created.status.evaluator.local_feedback, 'configured');
  assert.equal(created.status.evaluator.submission, 'configured');
  assert.equal(created.status.cost.state, 'configured');
  assert.equal(created.status.learning.state, 'configured');
  assert.ok(created.config);
  assert.equal(created.config?.evaluator?.endpoint, 'http://127.0.0.1:4317');
  assert.equal(reviewerIdentityForModel(created.config, 'gpt-6.1-sol')?.client_id, 'client-1');
  assert.equal(reviewerIdentityForModel(created.config, 'gpt-6-luna'), null);
  const content = await readFile(filename, 'utf8');
  const loaded = await loadIntegrationConfig(filename);
  assert.deepEqual(loaded, created);
  assert.deepEqual(await readdir(tmp.directory), ['integration.json']);
  await assert.rejects(createIntegrationConfig(filename, value), /EEXIST/);
  assert.equal(await readFile(filename, 'utf8'), content);
});

test('configures multiple existing reviewer identities and matches only the exact actual model', async (t) => {
  const tmp = await temporary(t);
  const filename = tmp.file('reviewers.json');
  const reviewers = [
    {
      reviewer_model: 'gpt-6.1-sol',
      client_id: 'client-sol',
      private_key_file: path.join(tmp.directory, 'sol.key'),
    },
    {
      reviewer_model: 'gpt-6-luna',
      client_id: 'client-luna',
      private_key_file: path.join(tmp.directory, 'luna.key'),
    },
  ];
  const result = await createIntegrationConfig(filename, {
    version: 1,
    evaluator: {
      endpoint: 'http://127.0.0.1:4317',
      queue_dir: path.join(tmp.directory, 'queue'),
      task_salt_file: path.join(tmp.directory, 'salt'),
      reviewers,
    },
  });
  assert.equal(result.status.evaluator.state, 'configured');
  assert.equal(result.status.evaluator.submission, 'configured');
  assert.ok(result.config);
  assert.deepEqual(result.config?.evaluator?.reviewers, reviewers);
  assert.equal(reviewerIdentityForModel(result.config, 'gpt-6.1-sol')?.client_id, 'client-sol');
  assert.equal(reviewerIdentityForModel(result.config, 'gpt-6-luna')?.client_id, 'client-luna');
  assert.equal(reviewerIdentityForModel(result.config, 'GPT-6-LUNA'), null);
  assert.equal(reviewerIdentityForModel(result.config, 'gpt-6-astra'), null);
  assert.deepEqual((await loadIntegrationConfig(filename)).config?.evaluator?.reviewers, reviewers);
  assert.deepEqual(await readdir(tmp.directory), ['reviewers.json']);
});

test('rejects ambiguous or duplicate reviewer identities and never stores secret values', async (t) => {
  const tmp = await temporary(t);
  const first = {
    reviewer_model: 'alpha',
    client_id: 'client-a',
    private_key_file: path.join(tmp.directory, 'a.key'),
  };
  const second = {
    reviewer_model: 'beta',
    client_id: 'client-b',
    private_key_file: path.join(tmp.directory, 'b.key'),
  };
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [first, { ...second, reviewer_model: 'alpha' }] },
      }),
    /model identities.*unique/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [first, { ...second, client_id: 'client-a' }] },
      }),
    /client identities.*unique/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [first], client_id: 'client-a' },
      }),
    /either legacy/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [first], reviewer_model: 'alpha' },
      }),
    /either legacy/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [{ ...first, private_key: 'secret' }] },
      }),
    /unknown/i,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [{ ...first, client_id: 'sk-secret-token' }] },
      }),
    /non-secret/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { reviewers: [{ reviewer_model: 'alpha', client_id: 'client-a' }] },
      }),
    /local path/,
  );
  assert.throws(
    () =>
      configurationStatus({
        version: 1,
        evaluator: { reviewers: [{ reviewer_model: 'alpha', client_id: 'client-a' } as never] },
      }),
    /local path/,
  );
  const empty = validateIntegrationConfig({
    version: 1,
    evaluator: {
      endpoint: 'http://127.0.0.1:4317',
      queue_dir: tmp.directory,
      task_salt_file: path.join(tmp.directory, 'salt'),
      reviewers: [],
    },
  });
  assert.equal(configurationStatus(empty).evaluator.submission, 'unconfigured');
  assert.ok(configurationStatus(empty).evaluator.missing.includes('reviewers'));
  const invalidFile = path.join(tmp.directory, 'invalid.json');
  await assert.rejects(
    createIntegrationConfig(invalidFile, {
      version: 1,
      evaluator: { reviewers: [{ ...first, private_key: 'secret' }] },
    }),
    /unknown/i,
  );
  assert.deepEqual(await readdir(tmp.directory), []);
});

test('reports absent file and partial independent sections without creating files', async (t) => {
  const tmp = await temporary(t);
  const missing = path.join(tmp.directory, 'missing.json');
  const result = await loadIntegrationConfig(missing);
  assert.equal(result.config, null);
  assert.equal(result.status.file, 'unconfigured');
  assert.equal(result.status.evaluator.profiles, 'unconfigured');
  assert.deepEqual(await readdir(tmp.directory), []);
  const partial = validateIntegrationConfig({
    version: 1,
    evaluator: { endpoint: 'http://[::1]:4317', queue_dir: tmp.directory },
    cost: { allow_api_equivalent: false, max_age_days: 1 },
    learning: { state_dir: tmp.directory, reuse_enabled: true },
  });
  const status = configurationStatus(partial);
  assert.equal(status.evaluator.state, 'unconfigured');
  assert.equal(status.evaluator.profiles, 'configured');
  assert.equal(status.evaluator.local_feedback, 'unconfigured');
  assert.ok(status.evaluator.missing.includes('task_salt_file'));
  assert.equal(status.cost.state, 'configured');
  assert.equal(status.cost.allowed, false);
  assert.equal(status.learning.state, 'unconfigured');
  assert.deepEqual(status.learning.missing, ['scope']);
});

test('rejects remote endpoints, credentials, unknown fields, invalid policy and nonlocal paths', () => {
  for (const endpoint of [
    'http://localhost:4317',
    'https://example.com',
    'http://127.0.0.2:4317',
    'http://user:pass@127.0.0.1:4317',
    'http://127.0.0.1:4317/?token=secret',
    'http://127.0.0.1:4317/other',
  ])
    assert.throws(() => validateIntegrationConfig({ version: 1, evaluator: { endpoint } }));
  assert.throws(
    () => validateIntegrationConfig({ version: 1, evaluator: { private_key: 'secret' } }),
    /unknown/i,
  );
  assert.throws(
    () => validateIntegrationConfig({ version: 1, evaluator: { client_id: 'sk-private-token' } }),
    /non-secret/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({ version: 1, evaluator: { private_key_file: 'relative.key' } }),
    /absolute/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { private_key_file: path.join(tmpdir(), 'sk-secret-token') },
      }),
    /credential/,
  );
  assert.throws(
    () => validateIntegrationConfig({ version: 1, evaluator: { queue_dir: '\\\\example\\share' } }),
    /local path/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        evaluator: { queue_dir: path.join(tmpdir(), '\u4e2d') },
      }),
    /local path/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        cost: { allow_api_equivalent: true, max_age_days: 0 },
      }),
    /1 to 365/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        cost: { allow_api_equivalent: true, max_age_days: 30, task_token_scope: 'bad' },
      }),
    /scope/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        learning: { state_dir: 'relative', reuse_enabled: true },
      }),
    /absolute/,
  );
  assert.throws(
    () =>
      validateIntegrationConfig({
        version: 1,
        learning: { state_dir: tmpdir(), reuse_enabled: true, python: 'python' },
      }),
    /absolute/,
  );
  assert.throws(() => validateIntegrationConfig({ version: 2 }), /version/);
});

test('accepts UTF-8 BOM in an otherwise valid manually written config', async (t) => {
  const tmp = await temporary(t);
  const filename = tmp.file('bom.json');
  await writeFile(filename, '\uFEFF{"version":1}', 'utf8');
  assert.equal((await loadIntegrationConfig(filename)).config?.version, 1);
});

test('rejects a config reached through a linked parent directory', async (t) => {
  const tmp = await temporary(t);
  const target = await tmp.subdirectory('actual');
  const actualConfig = tmp.file(path.join('actual', 'config.json'));
  await writeFile(actualConfig, '{"version":1}');
  const pointer = path.join(tmp.directory, 'pointer');
  try {
    await symlink(target, pointer, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Host does not permit directory-link creation');
      return;
    }
    throw error;
  }
  tmp.file('pointer');
  await assert.rejects(loadIntegrationConfig(path.join(pointer, 'config.json')), /without links/);
  await assert.rejects(
    createIntegrationConfig(path.join(pointer, 'new.json'), { version: 1 }),
    /without links/,
  );
});

test('rejects malformed, oversized, non-regular and linked config files', async (t) => {
  const tmp = await temporary(t);
  const malformed = tmp.file('malformed.json');
  await writeFile(malformed, '{"client_id":"sk-secret');
  await assert.rejects(
    loadIntegrationConfig(malformed),
    (error: Error) => error.message === 'Invalid config JSON',
  );
  const oversized = tmp.file('oversized.json');
  await writeFile(oversized, ' '.repeat(65537));
  await assert.rejects(loadIntegrationConfig(oversized), /bounded regular/);
  const directory = await tmp.subdirectory('folder.json');
  await assert.rejects(loadIntegrationConfig(directory), /regular/);
  const target = tmp.file('target.json');
  await writeFile(target, '{"version":1}');
  const hardlink = path.join(tmp.directory, 'hardlink.json');
  try {
    await link(target, hardlink);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return;
    throw error;
  }
  tmp.file('hardlink.json');
  await assert.rejects(loadIntegrationConfig(hardlink), /without links/);
  await assert.rejects(loadIntegrationConfig(target), /without links/);
});

test('rejects a symbolic-link config when the host supports creating one', async (t) => {
  const tmp = await temporary(t);
  const target = tmp.file('target.json');
  await writeFile(target, '{"version":1}');
  const linkPath = path.join(tmp.directory, 'linked.json');
  try {
    await symlink(target, linkPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Host does not permit symlink creation');
      return;
    }
    throw error;
  }
  tmp.file('linked.json');
  await assert.rejects(loadIntegrationConfig(linkPath), /without links/);
  await assert.rejects(createIntegrationConfig(linkPath, { version: 1 }), /EEXIST/);
});
