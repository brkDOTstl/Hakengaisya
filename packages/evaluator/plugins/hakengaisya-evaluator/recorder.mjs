import { createPrivateKey, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { prepareReport, submitReport } from './runtime/sdk/client.mjs';
import { assert, canonical, object, sha256, validateReport } from './runtime/src/contract.mjs';

export function defaultHome() {
  return process.env.HAKENGAISYA_RECORDER_HOME ?? path.join(homedir(), '.hakengaisya-evaluator');
}

export class Recorder {
  constructor(home = defaultHome(), upload = submitReport) {
    this.home = path.resolve(home);
    this.upload = upload;
  }
  async config() {
    const config = JSON.parse(await readFile(path.join(this.home, 'connection.json'), 'utf8'));
    object(config, ['version', 'server_url', 'client_id', 'reviewer_model']);
    assert(config.version === 1, 'Unsupported recorder configuration');
    const url = new URL(config.server_url);
    assert(
      !url.username && !url.password && !url.search && !url.hash,
      'Use a clean service origin without credentials',
    );
    assert(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)),
      'Remote service must use HTTPS',
    );
    return config;
  }
  async form(input, config) {
    object(
      input,
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
  async save(report) {
    const pending = path.join(this.home, 'pending');
    await mkdir(pending, { recursive: true, mode: 0o700 });
    const target = path.join(pending, `${report.report_id}.json`);
    try {
      await writeFile(target, `${canonical(report)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert(
        canonical(JSON.parse(await readFile(target, 'utf8'))) === canonical(report),
        'Record identifier has different local content',
        409,
      );
    }
    return target;
  }
  async send(report, config) {
    const privateKey = createPrivateKey(await readFile(path.join(this.home, 'agent.key'), 'utf8'));
    return this.upload(config.server_url, report, { clientId: config.client_id, privateKey });
  }
  async flush(config, limit = 10) {
    const pending = path.join(this.home, 'pending');
    let files;
    try {
      files = (await readdir(pending))
        .filter((file) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(file))
        .sort()
        .slice(0, limit);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const receipts = [];
    for (const file of files) {
      const source = path.join(pending, file);
      const report = JSON.parse(await readFile(source, 'utf8'));
      validateReport(report);
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
        const rejected = [400, 403, 409, 413, 415].includes(error.status);
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
  async record(input) {
    let config;
    try {
      config = await this.config();
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error('Recorder needs one-time connection setup before recording.');
      throw error;
    }
    const report = await this.form(input, config);
    const sent = path.join(this.home, 'sent', `${report.report_id}.json`);
    try {
      const previous = JSON.parse(await readFile(sent, 'utf8'));
      assert(
        canonical(previous) === canonical(report),
        'Record identifier has different accepted content',
        409,
      );
      return { report_id: report.report_id, status: 'accepted', repeated: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
