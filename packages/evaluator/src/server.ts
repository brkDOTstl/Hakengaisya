import { verify } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingText } from '../sdk/client.ts';
import type { Difficulty, Dimension, Domain, EvaluationKind, Skill, TaskType } from './contract.ts';
import { assert, DIMENSIONS, KINDS, SKILLS, TASK_TYPES, validateReport } from './contract.ts';
import { dimensionDefinitions, modelDetail, publicReference, publicReferences } from './display.ts';
import { displayRanking, recommend } from './profiles.ts';
import { Store } from './store.ts';
import type { DispatchNeeds, ProfileFilters, RegistryEntry, StatusError } from './types.ts';

interface AppOptions {
  now?: () => number;
  maxReports?: number;
}

interface RateBucket {
  start: number;
  count: number;
}

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
async function bodyText(request: IncomingMessage): Promise<string> {
  assert(
    request.headers['content-type']?.split(';')[0] === 'application/json',
    'Use application/json',
    415,
  );
  if (request.headers['content-length'])
    assert(Number(request.headers['content-length']) <= 16384, 'Payload too large', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert(size <= 16384, 'Payload too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp(
  store: Store,
  { now = Date.now, maxReports = 50000 }: AppOptions = {},
): Server {
  const rate = new Map<string, RateBucket>();
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const url = new URL(request.url as string, 'http://localhost');
      if (request.method === 'GET' && ['/health', '/api/v1/health'].includes(url.pathname))
        return json(response, 200, {
          ok: true,
          service: 'Hakengaisya-evaluator',
          records: store.count(),
        });
      if (request.method === 'GET' && url.pathname === '/api/v1/taxonomy')
        return json(response, 200, {
          dimensions: DIMENSIONS,
          dimension_definitions: dimensionDefinitions,
          skills: SKILLS,
          task_types: TASK_TYPES,
          evaluation_kinds: KINDS,
        });
      if (request.method === 'GET' && url.pathname === '/api/v1/public-references')
        return json(response, 200, publicReferences());
      if (request.method === 'GET' && url.pathname === '/api/v1/model-details') {
        const model = url.searchParams.get('model');
        assert(
          typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(model),
          'Specify a model identifier',
        );
        const kind = url.searchParams.get('kind') ?? 'local_work';
        assert((KINDS as readonly string[]).includes(kind), 'Unknown kind');
        const filters: ProfileFilters = { evaluation_kind: kind as EvaluationKind };
        // has() was just checked, so get() returns the parameter value.
        for (const key of [
          'route',
          'effort',
          'domain',
          'task_type',
          'difficulty',
          'skill',
        ] as const)
          if (url.searchParams.has(key)) filters[key] = url.searchParams.get(key) as string;
        return json(response, 200, modelDetail(store.projection().profiles, model, filters));
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/rankings') {
        const kind = url.searchParams.get('kind') ?? 'local_work';
        assert((KINDS as readonly string[]).includes(kind), 'Unknown kind');
        const profiles = store
          .projection()
          .profiles.filter(
            (profile) =>
              profile.evaluation_kind === kind &&
              (!url.searchParams.get('skill') || profile.skill === url.searchParams.get('skill')) &&
              (!url.searchParams.get('difficulty') ||
                profile.difficulty === url.searchParams.get('difficulty')),
          );
        return json(response, 200, {
          rows: displayRanking(profiles)
            .slice(0, 100)
            .map((row) => ({ ...row, public_reference: publicReference(row.model_id) })),
          kind,
          purpose: 'Optional human display; not a dispatch decision.',
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/profiles') {
        const kind = url.searchParams.get('kind') ?? 'local_work';
        assert((KINDS as readonly string[]).includes(kind), 'Unknown kind');
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        assert(
          Number.isInteger(limit) &&
            limit > 0 &&
            limit <= 100 &&
            Number.isInteger(offset) &&
            offset >= 0,
          'Invalid pagination',
        );
        const projection = store.projection();
        const profiles = projection.profiles.filter(
          (profile) =>
            profile.evaluation_kind === kind &&
            (!url.searchParams.get('skill') || profile.skill === url.searchParams.get('skill')) &&
            (!url.searchParams.get('model') || profile.model_id === url.searchParams.get('model')),
        );
        return json(response, 200, {
          total: profiles.length,
          offset,
          profiles: profiles.slice(offset, offset + limit),
          operational: projection.operational,
          weighting_basis: projection.weighting_basis,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/recommendations') {
        const skill = url.searchParams.get('skill');
        const difficulty = url.searchParams.get('difficulty');
        assert(
          skill !== null &&
            (SKILLS as readonly string[]).includes(skill) &&
            difficulty !== null &&
            ['routine', 'standard', 'complex'].includes(difficulty),
          'Specify a valid skill and difficulty',
        );
        const task_type = url.searchParams.get('task_type');
        const domain = url.searchParams.get('domain');
        assert(
          task_type !== null &&
            (TASK_TYPES as readonly string[]).includes(task_type) &&
            domain !== null &&
            ['software-engineering', 'technical-product'].includes(domain),
          'Specify a valid task_type and domain',
        );
        const needs: DispatchNeeds = {
          skill: skill as Skill,
          difficulty: difficulty as Difficulty,
          task_type: task_type as TaskType,
          domain: domain as Domain,
        };
        for (const [parameter, key] of [
          ['minimum_score', 'minimum_score'],
          ['max_cost_usd', 'max_cost_usd'],
          ['max_wall_seconds', 'max_wall_seconds'],
        ] as const)
          if (url.searchParams.has(parameter)) {
            const value = Number(url.searchParams.get(parameter));
            assert(
              Number.isFinite(value) && value >= 0 && (key !== 'minimum_score' || value <= 10),
              'Invalid dispatch threshold',
            );
            needs[key] = value;
          }
        if (url.searchParams.has('dimensions')) {
          // has() was just checked, so get() returns the parameter value.
          const dimensions = (url.searchParams.get('dimensions') as string).split(',');
          assert(
            dimensions.length > 0 &&
              dimensions.every((key) => (DIMENSIONS as readonly string[]).includes(key)),
            'Invalid required dimensions',
          );
          needs.dimensions = dimensions as Dimension[];
        }
        return json(response, 200, recommend(store.projection().profiles, needs));
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/evaluations' && !url.search) {
        const clientId = request.headers['x-agent-client'];
        const client = typeof clientId === 'string' ? store.client(clientId) : null;
        assert(client?.enabled, 'Registered agent credentials required', 401);
        const timestamp = request.headers['x-agent-timestamp'];
        const nonce = request.headers['x-agent-nonce'];
        const signature = request.headers['x-agent-signature'];
        const current = now();
        assert(
          typeof timestamp === 'string' &&
            /^\d{13}$/.test(timestamp) &&
            Math.abs(current - Number(timestamp)) <= 300000,
          'Signature timestamp expired or invalid',
          401,
        );
        assert(
          typeof nonce === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(nonce),
          'Invalid request nonce',
          401,
        );
        assert(
          typeof signature === 'string' && /^[a-zA-Z0-9+/]{86}==$/.test(signature),
          'Invalid signature',
          401,
        );
        const raw = await bodyText(request);
        assert(
          verify(
            null,
            Buffer.from(signingText(timestamp, nonce, raw)),
            client.public_key,
            Buffer.from(signature, 'base64'),
          ),
          'Signature verification failed',
          401,
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          assert(false, 'Invalid JSON');
        }
        const report = validateReport(parsed);
        assert(
          report.reviewer_model === client.model,
          'Agent model does not match enrolled identity',
          403,
        );
        assert(store.count() < maxReports, 'Service capacity reached', 503);
        const bucket = rate.get(client.id) ?? { start: current, count: 0 };
        if (current - bucket.start >= 60000) {
          bucket.start = current;
          bucket.count = 0;
        }
        assert(bucket.count < 60, 'Agent submission rate exceeded', 429);
        bucket.count += 1;
        rate.set(client.id, bucket);
        const inserted = store.append(client, nonce, report, current);
        return json(response, inserted ? 201 : 200, {
          accepted: true,
          report_id: report.report_id,
          inserted,
          profiles_updated: true,
        });
      }
      if (
        request.method === 'GET' &&
        ['/', '/app.mjs', '/radar.mjs', '/style.css'].includes(url.pathname)
      ) {
        const filename = {
          '/': 'index.html',
          '/app.mjs': 'app.mjs',
          '/radar.mjs': 'radar.mjs',
          '/style.css': 'style.css',
          // The guard above restricts pathname to these four routes.
        }[url.pathname as '/' | '/app.mjs' | '/radar.mjs' | '/style.css'];
        const contentType = {
          '/': 'text/html',
          '/app.mjs': 'text/javascript',
          '/radar.mjs': 'text/javascript',
          '/style.css': 'text/css',
        }[url.pathname as '/' | '/app.mjs' | '/radar.mjs' | '/style.css'];
        response.writeHead(200, {
          'content-type': `${contentType}; charset=utf-8`,
          'cache-control': 'no-cache',
        });
        response.end(await readFile(path.join(webRoot, filename)));
        return;
      }
      json(response, ['GET', 'POST'].includes(request.method as string) ? 404 : 405, {
        error: 'No manual profile editing endpoint is available',
      });
    } catch (error) {
      const failure = error as StatusError;
      if (!response.headersSent)
        json(response, failure.status ?? 500, {
          error: failure.status ? failure.message : 'Internal service error',
        });
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.env.EVALUATOR_DATA_DIR ?? '.data');
  await mkdir(directory, { recursive: true });
  // Bundled fixture maintained with this package; parsed to its documented shape.
  const registry: RegistryEntry[] =
    process.env.EVALUATOR_WITH_LOCAL_HISTORY === '1'
      ? JSON.parse(
          await readFile(new URL('../fixtures/credibility-history.json', import.meta.url), 'utf8'),
        )
      : [];
  const store = new Store(path.join(directory, 'evaluator.sqlite'), registry);
  const server = createApp(store);
  const host = process.env.EVALUATOR_HOST ?? '127.0.0.1';
  const port = Number(process.env.EVALUATOR_PORT ?? 4317);
  server.listen(port, host, () =>
    console.log(`Hakengaisya-evaluator listening on http://${host}:${port}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () =>
      server.close(() => {
        store.close();
        process.exit(0);
      }),
    );
}
