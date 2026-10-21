import { createPrivateKey, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StatusError } from '../../src/types.ts';
import type { ClientCredentials, SubmitResult } from './runtime/sdk/client.ts';
import { prepareReport, submitReport } from './runtime/sdk/client.ts';
import type {
  Attribution,
  Difficulty,
  Dimension,
  Domain,
  EvaluationKind,
  Relationship,
  Report,
  Skill,
  TaskType,
  Usage,
} from './runtime/src/contract.ts';
import { assert, canonical, object, sha256, validateReport } from './runtime/src/contract.ts';

export interface RecorderConfig {
  version: 1;
  server_url: string;
  client_id: string;
  reviewer_model: string;
}

export interface RecorderForm {
  subject_model: string;
  task_type: TaskType;
  difficulty: Difficulty;
  tags: Skill[];
  ratings: Partial<Record<Dimension, number | null>>;
  comment: string;
  example: string;
  guidance: string;
  task_ref?: string;
  record_id?: string;
  domain?: Domain;
  route?: string;
  effort?: string;
  evaluation_kind?: EvaluationKind;
  relationship?: Relationship;
  attribution?: Attribution;
  usage?: Partial<Usage>;
}

export interface RecorderReceipt {
  report_id: string;
  status: 'accepted' | 'rejected' | 'queued';
  reason?: string;
  repeated?: boolean;
}

export type RecorderUpload = (
  baseUrl: string,
  report: Report,
  credentials: ClientCredentials,
) => Promise<SubmitResult>;

export function defaultHome(): string {
  return process.env.HAKENGAISYA_RECORDER_HOME ?? path.join(homedir(), '.hakengaisya-evaluator');
}

export class Recorder {
  home: string;
  upload: RecorderUpload;

  constructor(home: string = defaultHome(), upload: RecorderUpload = submitReport) {
    this.home = path.resolve(home);
    this.upload = upload;
  }
  async config(): Promise<RecorderConfig> {
    const config: unknown = JSON.parse(
      await readFile(path.join(this.home, 'connection.json'), 'utf8'),
    );
    object(config, ['version', 'server_url', 'client_id', 'reviewer_model']);
    assert(config.version === 1, 'Unsupported recorder configuration');
    const url = new URL(config.server_url as string);
    assert(
      !url.username && !url.password && !url.search && !url.hash,
      'Use a clean service origin without credentials',
    );
    assert(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)),
      'Remote service must use HTTPS',
    );
    return config as unknown as RecorderConfig;
  }
  async form(raw: unknown, config: RecorderConfig): Promise<Report> {
    object(
      raw,
      [
        'subject_model',
        'task_type',
        'difficulty',
        'tags',
        'ratings',
        'comment',
        'example',
        'guidance',
        'task_ref',
        'record_id',
        'domain',
        'route',
        'effort',
        'evaluation_kind',
        'relationship',
        'attribution',
        'usage',
      ],
      [
        'subject_model',
        'task_type',
        'difficulty',
        'tags',
        'ratings',
        'comment',
        'example',
        'guidance',
      ],
    );
    // Field values are validated by prepareReport/validateReport below.
    const input = raw as unknown as RecorderForm;
    const salt = await readFile(path.join(this.home, 'task-salt'), 'utf8');
    const report = prepareReport(
      {
        report_id: input.record_id ?? randomUUID(),
        reviewer_model: config.reviewer_model,
        subject_model: input.subject_model,
        route: input.route ?? 'codex',
        effort: input.effort ?? 'unknown',
        local_task_identity: input.task_ref ?? randomUUID(),
        evaluation_kind: input.evaluation_kind ?? 'local_work',
        task: {
          domain: input.domain ?? 'software-engineering',
          type: input.task_type,
          difficulty: input.difficulty,
          skills: input.tags,
        },
        ratings: input.ratings,
        comment: input.comment,
        example: input.example,
        guidance: input.guidance,
        relationship: input.relationship ?? 'review',
        attribution: input.attribution ?? 'model',
        usage: input.usage,
      },
      salt,
    );
    if (!input.record_id && input.task_ref)
      report.report_id = `rec-${sha256(canonical({ ...report, report_id: null })).slice(0, 40)}`;
    validateReport(report);
    return report;
  }
  async save(report: Report): Promise<string> {
    const pending = path.join(this.home, 'pending');
    await mkdir(pending, { recursive: true, mode: 0o700 });
    const target = path.join(pending, `${report.report_id}.json`);
    try {
      await writeFile(target, `${canonical(report)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assert(
        canonical(JSON.parse(await readFile(target, 'utf8')) as unknown) === canonical(report),
        'Record identifier has different local content',
        409,
      );
    }
    return target;
  }
  async send(report: Report, config: RecorderConfig): Promise<SubmitResult> {
    const privateKey = createPrivateKey(await readFile(path.join(this.home, 'agent.key'), 'utf8'));
    return this.upload(config.server_url, report, { clientId: config.client_id, privateKey });
  }
  async flush(config: RecorderConfig, limit = 10): Promise<RecorderReceipt[]> {
    const pending = path.join(this.home, 'pending');
    let files: string[];
    try {
      files = (await readdir(pending))
        .filter((file) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(file))
        .sort()
        .slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const receipts: RecorderReceipt[] = [];
    for (const file of files) {
      const source = path.join(pending, file);
      const report = validateReport(JSON.parse(await readFile(source, 'utf8')) as unknown);
      try {
        const receipt = await this.send(report, config);
        assert(
          receipt.accepted === true && receipt.report_id === report.report_id,
          'Unexpected service receipt',
        );
        await mkdir(path.join(this.home, 'sent'), { recursive: true, mode: 0o700 });
        await rename(source, path.join(this.home, 'sent', file));
        receipts.push({ report_id: report.report_id, status: 'accepted' });
      } catch (error) {
        const status = (error as StatusError).status;
        const rejected = status !== undefined && [400, 403, 409, 413, 415].includes(status);
        if (rejected) {
          await mkdir(path.join(this.home, 'rejected'), { recursive: true, mode: 0o700 });
          await rename(source, path.join(this.home, 'rejected', file));
        }
        receipts.push({
          report_id: report.report_id,
          status: rejected ? 'rejected' : 'queued',
          reason: rejected
            ? 'Service rejected this record; inspect and correct it.'
            : 'Upload unavailable; retained locally for retry.',
        });
        if (!rejected) break;
      }
    }
    return receipts;
  }
  async record(input: unknown): Promise<RecorderReceipt> {
    let config: RecorderConfig;
    try {
      config = await this.config();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error('Recorder needs one-time connection setup before recording.');
      throw error;
    }
    const report = await this.form(input, config);
    const sent = path.join(this.home, 'sent', `${report.report_id}.json`);
    try {
      const previous: unknown = JSON.parse(await readFile(sent, 'utf8'));
      assert(
        canonical(previous) === canonical(report),
        'Record identifier has different accepted content',
        409,
      );
      return { report_id: report.report_id, status: 'accepted', repeated: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.save(report);
    const receipts = await this.flush(config);
    return (
      receipts.find((receipt) => receipt.report_id === report.report_id) ?? {
        report_id: report.report_id,
        status: 'queued',
        reason: 'Saved behind pending records; retry when the service is available.',
      }
    );
  }
}
