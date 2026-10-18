import { createHmac, randomUUID, sign } from 'node:crypto';
import { assert, canonical, redactText, sha256, validateReport } from '../src/contract.mjs';

export const signingText = (timestamp, nonce, body) => ['POST', '/api/v1/evaluations', timestamp, nonce, sha256(body)].join('\n');

export function prepareReport(localReport, taskSalt) {
  // Select upload fields explicitly; local paths, files, prompts, and transcripts never pass through.
  const report = {
    version: 1, report_id: localReport.report_id ?? randomUUID(),
    reviewer_model: localReport.reviewer_model, subject_model: localReport.subject_model,
    route: localReport.route, effort: localReport.effort,
    task_token: createHmac('sha256', taskSalt).update(localReport.local_task_identity).digest('hex'),
    evaluation_kind: localReport.evaluation_kind,
    task: { domain: localReport.task.domain, type: localReport.task.type, difficulty: localReport.task.difficulty, skills: [...localReport.task.skills] },
    ratings: Object.fromEntries(['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].filter(key => Object.hasOwn(localReport.ratings, key)).map(key => [key, localReport.ratings[key]])),
    comment: redactText(localReport.comment), example: redactText(localReport.example), guidance: redactText(localReport.guidance),
    relationship: localReport.relationship, attribution: localReport.attribution,
    usage: Object.fromEntries(['input_tokens', 'output_tokens', 'cost_usd', 'wall_seconds'].map(key => [key, localReport.usage?.[key] ?? null]))
  };
  assert(typeof taskSalt === 'string' && taskSalt.length >= 32, 'Use a local random task salt of at least 32 characters');
  validateReport(report);
  return report;
}

export function signedRequest(report, { clientId, privateKey, timestamp = String(Date.now()), nonce = randomUUID() }) {
  validateReport(report);
  const body = canonical(report);
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-client': clientId, 'x-agent-timestamp': timestamp, 'x-agent-nonce': nonce, 'x-agent-signature': sign(null, Buffer.from(signingText(timestamp, nonce, body)), privateKey).toString('base64') }, body };
}

export async function submitReport(baseUrl, report, credentials) {
  const url = new URL(baseUrl);
  assert(!url.username && !url.password && !url.search && !url.hash, 'Use a clean service URL without credentials');
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Remote uploads require HTTPS');
  const response = await fetch(new URL('/api/v1/evaluations', url), { ...signedRequest(report, credentials), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  assert(response.ok, result.error ?? 'Upload failed', response.status);
  return result;
}

export async function collectAndSubmit({ peers, subject, askPeer, upload, task }) {
  const requests = peers.filter(peer => peer.model_id !== subject.model_id);
  const results = await Promise.allSettled(requests.map(async peer => {
    const report = await askPeer({ peer, subject, task, prompt: 'Return structured skill guidance based on shared local work. Preserve difficulty, useful strengths, required support, and measured cost/speed. Provide only a de-identified short example. Do not invent ratings or costs for unobserved dimensions.' });
    assert(report.reviewer_model === peer.model_id && report.subject_model === subject.model_id, 'Peer response identity mismatch');
    assert(canonical(report.task) === canonical(task), 'Peer response task scope mismatch');
    return upload(report, peer);
  }));
  return results.map((result, index) => ({ peer: requests[index].model_id, status: result.status, result: result.status === 'fulfilled' ? result.value : undefined, error: result.status === 'rejected' ? result.reason.message : undefined }));
}
