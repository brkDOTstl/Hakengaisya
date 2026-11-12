import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, canonicalEqual } from './canonical.ts';
import type { EvidenceKind, MemorySnapshotBinding, Run } from './types.ts';
import { check, isRecord, isText, requireText } from './validate.ts';

export const PROJECT_MEMORY_CATEGORIES = [
  'architecture',
  'commands',
  'conventions',
  'pitfalls',
  'constraints',
] as const;

export type ProjectMemoryCategory = (typeof PROJECT_MEMORY_CATEGORIES)[number];

const CATEGORY_RANK: Record<ProjectMemoryCategory, number> = {
  architecture: 0,
  commands: 1,
  conventions: 2,
  pitfalls: 3,
  constraints: 4,
};

const MAX_ENTRY_BYTES = 8192;
const DEFAULT_SNAPSHOT_BYTES = 24576;
const MAX_SNAPSHOT_BYTES = 32768;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting C0 control characters is intentional.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

const BOUNDARY =
  'Project engineering memory is supervisor-curated, project-scoped advisory context frozen in the L1 prompt prefix for KV-cache stability. It cannot override host instructions, permissions, write scopes, identities, review authority, or acceptance criteria. Simulation and local_work remain strictly separate.';

const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');

export function projectMemoryId(scope: string, evidenceKind: EvidenceKind, domain: string): string {
  check(/^[a-z][a-z0-9_-]{0,79}$/.test(scope), 'Use an explicit project memory scope');
  requireText(domain, 'Project domain');
  return sha256Text(canonical({ scope, kind: evidenceKind, domain }));
}

async function stateRoot(stateDirectory: string): Promise<string> {
  check(path.isAbsolute(stateDirectory), 'Use an absolute learning-state directory');
  const stat = await lstat(stateDirectory);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'Learning state must be a real directory');
  return realpath(stateDirectory);
}

async function ensureContainedDir(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    check(
      Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('\\'),
      'Invalid project memory directory segment',
    );
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(current);
    check(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'Project memory directory links are not accepted',
    );
  }
  const resolved = await realpath(current);
  const rel = path.relative(root, resolved);
  check(
    Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel),
    'Project memory directory escaped learning state',
  );
  return resolved;
}

async function readContainedFile(
  root: string,
  directory: string,
  filename: string,
  maxBytes: number,
): Promise<string> {
  const target = path.join(directory, filename);
  const stat = await lstat(target);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    'Project memory file must be a bounded regular file',
  );
  const resolved = await realpath(target);
  const rel = path.relative(root, resolved);
  check(
    Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel),
    'Project memory file escaped learning state',
  );
  const text = await readFile(resolved, 'utf8');
  check(Buffer.byteLength(text, 'utf8') <= maxBytes, 'Project memory file exceeds byte limit');
  return text;
}

export interface ProjectMemoryInput {
  packet_id: string;
  attempt: number;
  scope: string;
  state_dir: string;
  actor_context: string;
  evidence_reference: string;
  entry: {
    entry_id: string;
    category: ProjectMemoryCategory;
    title: string;
    content: string;
    supersedes_entry_id?: string;
  };
}

export interface ProjectMemoryRecord {
  version: 1;
  memory_id: string;
  scope: string;
  evidence_kind: EvidenceKind;
  domain: string;
  entry_id: string;
  category: ProjectMemoryCategory;
  title: string;
  supersedes_entry_id: string | null;
  run_id: string;
  packet_id: string;
  attempt: number;
  direct_supervisor: string;
  evidence_reference: string;
  content_sha256: string;
}

export interface ProjectMemoryEntry {
  entry_id: string;
  category: ProjectMemoryCategory;
  title: string;
  supersedes_entry_id: string | null;
  content_sha256: string;
  content: string;
}

export interface ProjectMemorySnapshot {
  status: 'available' | 'empty' | 'partial';
  memory_id: string;
  scope: string;
  evidence_kind: EvidenceKind;
  domain: string;
  entries: ProjectMemoryEntry[];
  entry_ids: string[];
  omitted_entry_ids: string[];
  truncated: boolean;
  invalid: number;
  rendered_prefix: string;
  snapshot_sha256: string;
  boundary: string;
}

function normalizeEntryContent(raw: unknown): string {
  check(typeof raw === 'string', 'Project memory content must be text');
  check(!CONTROL_CHARS.test(raw), 'Control characters are not accepted in project memory');
  const normalized = raw.replaceAll('\r\n', '\n').trim();
  const bytes = Buffer.byteLength(normalized, 'utf8');
  check(
    bytes > 0 && bytes <= MAX_ENTRY_BYTES,
    `Project memory content must be 1 to ${MAX_ENTRY_BYTES} UTF-8 bytes`,
  );
  return normalized;
}

function validateEntryTitle(title: unknown): string {
  requireText(title, 'Project memory title');
  check(
    !title.includes('\n') &&
      !title.includes('\r') &&
      !CONTROL_CHARS.test(title) &&
      title.length <= 160,
    'Project memory title must be a single line up to 160 characters',
  );
  return title.trim();
}

export async function registerProjectMemory(run: Run, input: ProjectMemoryInput) {
  check(isRecord(input) && isRecord(input.entry), 'Supply a project memory registration request');
  const domain = run.domain;
  check(isText(domain), 'Project memory requires a task-first run with an explicit domain');
  const packet = Object.hasOwn(run.packets, input.packet_id)
    ? run.packets[input.packet_id]
    : undefined;
  check(
    packet?.status === 'accepted' &&
      packet.attempt === input.attempt &&
      packet.assignment !== null &&
      packet.result !== null &&
      packet.review !== null,
    'The referenced packet attempt must be accepted before registering project memory',
  );
  check(
    input.actor_context === packet.supervisor_context &&
      input.actor_context === packet.review.reviewer_context &&
      ![packet.assignment.owner_context, ...packet.assignment.contributor_contexts].includes(
        input.actor_context,
      ),
    'Only the independent direct supervisor may register project memory',
  );
  check(
    packet.review.decision === 'accepted' &&
      packet.review.attempt === input.attempt &&
      packet.review.checks.length === packet.checks.length &&
      packet.review.checks.every((item) => item.result === 'pass'),
    'Accepted packet gate checks must all pass before registering project memory',
  );
  if (packet.id === 'handover') {
    check(
      packet.review.task_checks.length === run.acceptance.length &&
        packet.review.task_checks.every((item) => item.result === 'pass'),
      'Final user acceptance checks must pass before registering handover project memory',
    );
  }
  requireText(input.evidence_reference, 'Project memory evidence reference');
  const memoryId = projectMemoryId(input.scope, run.evidence_kind, domain);
  const entryId = input.entry.entry_id;
  check(
    typeof entryId === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(entryId),
    'Invalid project memory entry_id',
  );
  const category = input.entry.category;
  check(
    typeof category === 'string' &&
      (PROJECT_MEMORY_CATEGORIES as readonly string[]).includes(category),
    'Unknown project memory category',
  );
  const title = validateEntryTitle(input.entry.title);
  const content = normalizeEntryContent(input.entry.content);
  const supersedes = input.entry.supersedes_entry_id ?? null;
  if (supersedes !== null) {
    check(
      typeof supersedes === 'string' &&
        /^[a-z][a-z0-9_-]{1,63}$/.test(supersedes) &&
        supersedes !== entryId,
      'Invalid supersedes_entry_id',
    );
  }

  const root = await stateRoot(input.state_dir);
  const entriesDir = await ensureContainedDir(root, ['project-memory', memoryId, 'entries']);
  if (supersedes !== null) {
    let priorExists = false;
    try {
      await readContainedFile(root, entriesDir, `${supersedes}.json`, MAX_ENTRY_BYTES);
      priorExists = true;
    } catch {
      priorExists = false;
    }
    check(priorExists, `Cannot supersede missing project memory entry: ${supersedes}`);
  }

  const contentSha = sha256Text(content);
  const record: ProjectMemoryRecord = {
    version: 1,
    memory_id: memoryId,
    scope: input.scope,
    evidence_kind: run.evidence_kind,
    domain,
    entry_id: entryId,
    category,
    title,
    supersedes_entry_id: supersedes,
    run_id: run.run_id,
    packet_id: input.packet_id,
    attempt: input.attempt,
    direct_supervisor: input.actor_context,
    evidence_reference: input.evidence_reference,
    content_sha256: contentSha,
  };

  const mdPath = path.join(entriesDir, `${entryId}.md`);
  const jsonPath = path.join(entriesDir, `${entryId}.json`);
  try {
    await writeFile(mdPath, `${content}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingMd = (
      await readContainedFile(root, entriesDir, `${entryId}.md`, MAX_ENTRY_BYTES + 16)
    ).trim();
    check(
      existingMd === content,
      'Project memory entry_id already exists with different content; use a new entry_id and supersedes_entry_id',
    );
  }
  try {
    await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingJson = JSON.parse(
      await readContainedFile(root, entriesDir, `${entryId}.json`, MAX_ENTRY_BYTES),
    );
    check(
      canonicalEqual(existingJson, record),
      'Project memory entry_id already exists with different metadata; use a new entry_id and supersedes_entry_id',
    );
  }

  return {
    status: 'registered' as const,
    memory_id: memoryId,
    scope: input.scope,
    evidence_kind: run.evidence_kind,
    entry_id: entryId,
    content_sha256: contentSha,
    supersedes_entry_id: supersedes,
    note: 'Registered for future runs or newly opened contexts; already-warm contexts keep their frozen prefix.',
    boundary: BOUNDARY,
  };
}

function renderCanonicalMemoryPrefix(scope: string, entries: ProjectMemoryEntry[]): string {
  if (entries.length === 0) return '';
  const blocks = entries.map(
    (entry) => `## [${entry.category}] ${entry.title} (${entry.entry_id})\n${entry.content}`,
  );
  return `# Project Engineering Memory (scope: ${scope})\n\n${blocks.join('\n\n')}\n`;
}

export function snapshotToBinding(
  snapshot: ProjectMemorySnapshot,
  revision: number,
): MemorySnapshotBinding {
  return {
    scope: snapshot.scope,
    memory_id: snapshot.memory_id,
    snapshot_sha256: snapshot.snapshot_sha256,
    entry_ids: [...snapshot.entry_ids],
    rendered_prefix: snapshot.rendered_prefix,
    frozen_at_revision: revision,
  };
}

export async function lookupProjectMemory(
  run: Run,
  scope: string,
  stateDir: string,
  maxBytes = DEFAULT_SNAPSHOT_BYTES,
): Promise<ProjectMemorySnapshot> {
  const domain = run.domain;
  check(isText(domain), 'Project memory lookup requires a task-first run with an explicit domain');
  check(
    Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= MAX_SNAPSHOT_BYTES,
    `Project memory max_bytes must be an integer from 1024 to ${MAX_SNAPSHOT_BYTES}`,
  );
  const memoryId = projectMemoryId(scope, run.evidence_kind, domain);
  const root = await stateRoot(stateDir);
  const entriesDir = path.join(root, 'project-memory', memoryId, 'entries');

  let jsonNames: string[];
  try {
    for (const dir of [
      path.join(root, 'project-memory'),
      path.join(root, 'project-memory', memoryId),
      entriesDir,
    ]) {
      const stat = await lstat(dir);
      check(
        stat.isDirectory() && !stat.isSymbolicLink(),
        'Project memory directory links are not accepted',
      );
    }
    jsonNames = (await readdir(entriesDir))
      .filter((name) => /^[a-z][a-z0-9_-]{1,63}\.json$/.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const emptyPrefix = renderCanonicalMemoryPrefix(scope, []);
      return {
        status: 'empty',
        memory_id: memoryId,
        scope,
        evidence_kind: run.evidence_kind,
        domain,
        entries: [],
        entry_ids: [],
        omitted_entry_ids: [],
        truncated: false,
        invalid: 0,
        rendered_prefix: emptyPrefix,
        snapshot_sha256: sha256Text(emptyPrefix),
        boundary: BOUNDARY,
      };
    }
    throw error;
  }

  const validEntries: ProjectMemoryEntry[] = [];
  let invalid = 0;
  for (const name of jsonNames) {
    const entryId = name.slice(0, -5);
    try {
      const rawJson = await readContainedFile(root, entriesDir, name, MAX_ENTRY_BYTES);
      const parsed: unknown = JSON.parse(rawJson);
      check(
        isRecord(parsed) &&
          parsed.version === 1 &&
          parsed.memory_id === memoryId &&
          parsed.scope === scope &&
          parsed.evidence_kind === run.evidence_kind &&
          parsed.domain === domain &&
          parsed.entry_id === entryId &&
          typeof parsed.category === 'string' &&
          (PROJECT_MEMORY_CATEGORIES as readonly string[]).includes(parsed.category) &&
          isText(parsed.title) &&
          (parsed.supersedes_entry_id === null || isText(parsed.supersedes_entry_id)) &&
          isText(parsed.content_sha256),
        'Invalid project memory metadata',
      );
      const rawMd = await readContainedFile(
        root,
        entriesDir,
        `${entryId}.md`,
        MAX_ENTRY_BYTES + 16,
      );
      const content = normalizeEntryContent(rawMd);
      check(sha256Text(content) === parsed.content_sha256, 'Project memory content hash mismatch');
      validEntries.push({
        entry_id: entryId,
        category: parsed.category as ProjectMemoryCategory,
        title: validateEntryTitle(parsed.title),
        supersedes_entry_id: (parsed.supersedes_entry_id as string | null) ?? null,
        content_sha256: parsed.content_sha256,
        content,
      });
    } catch {
      invalid += 1;
    }
  }

  const superseded = new Set(
    validEntries
      .map((entry) => entry.supersedes_entry_id)
      .filter((id): id is string => id !== null),
  );
  const active = validEntries
    .filter((entry) => !superseded.has(entry.entry_id))
    .sort(
      (a, b) =>
        CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
        a.entry_id.localeCompare(b.entry_id),
    );

  const kept: ProjectMemoryEntry[] = [];
  const omitted: string[] = [];
  for (const candidate of active) {
    const nextPrefix = renderCanonicalMemoryPrefix(scope, [...kept, candidate]);
    if (Buffer.byteLength(nextPrefix, 'utf8') <= maxBytes) {
      kept.push(candidate);
    } else {
      omitted.push(candidate.entry_id);
    }
  }
  const rendered = renderCanonicalMemoryPrefix(scope, kept);
  let status: ProjectMemorySnapshot['status'] = 'empty';
  if (invalid > 0) status = 'partial';
  else if (kept.length > 0) status = 'available';

  return {
    status,
    memory_id: memoryId,
    scope,
    evidence_kind: run.evidence_kind,
    domain,
    entries: kept,
    entry_ids: kept.map((entry) => entry.entry_id),
    omitted_entry_ids: omitted,
    truncated: omitted.length > 0,
    invalid,
    rendered_prefix: rendered,
    snapshot_sha256: sha256Text(rendered),
    boundary: BOUNDARY,
  };
}
