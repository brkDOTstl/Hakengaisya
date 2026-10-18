import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DIMENSIONS, aggregateFeedback, buildSurvey, digest, importLegacyChart, stableJSON, validateFeedback } from '../lib/staff.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const staff = path.join(root, 'staff');
const readJSON = async filename => JSON.parse(await readFile(filename, 'utf8'));
const encode = value => JSON.stringify(value, null, 2) + '\n';
const escapeHTML = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

async function immutableJSON(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  try { await writeFile(filename, encode(value), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (stableJSON(await readJSON(filename)) !== stableJSON(value)) throw new Error('An immutable record already exists with different content: ' + filename);
  }
}

async function optionalJSON(filename, fallback) {
  try { return await readJSON(filename); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function feedbackRecords() {
  const directory = path.join(staff, 'feedback');
  let files;
  try { files = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(filename => filename.endsWith('.json')).sort().map(filename => readJSON(path.join(directory, filename))));
}

function renderDashboard(projection, history, policy) {
  const cell = value => '<td>' + escapeHTML(value === null || value === undefined ? 'not measured' : value) + '</td>';
  const heading = '<tr><th>Model / context</th>' + DIMENSIONS.map(dimension => '<th title="' + escapeHTML(policy.dimensions[dimension]) + '">' + dimension + '</th>').join('') + '<th>Role fit / coverage</th></tr>';
  const activeRows = projection.profiles.map(profile => '<tr><th scope="row">' + escapeHTML(profile.model_id) + '<br><small>' + escapeHTML([profile.context.project_id, profile.context.role_id, profile.context.task_class, profile.context.difficulty, profile.effort].join(' / ')) + '</small></th>' + DIMENSIONS.map(dimension => cell(profile.dimensions[dimension].score)).join('') + cell(profile.role_fit.estimate === null ? null : profile.role_fit.estimate + ' / ' + Math.round(profile.role_fit.coverage * 100) + '%') + '</tr>').join('');
  const legacyRows = (history.profiles ?? []).map(profile => '<tr><th scope="row">' + escapeHTML(profile.name) + '<br><small>' + escapeHTML(profile.route) + '</small></th>' + DIMENSIONS.map(dimension => cell(profile.scores[dimension])).join('') + '<td>historical seed</td></tr>').join('');
  const details = projection.profiles.map(profile => '<details><summary>' + escapeHTML(profile.model_id + ' / ' + profile.context.difficulty + ' / ' + profile.context.role_id) + '</summary>' + DIMENSIONS.map(dimension => {
    const estimate = profile.dimensions[dimension];
    return '<h3>' + dimension + ' ' + escapeHTML(policy.dimensions[dimension]) + '</h3><p>' + escapeHTML(estimate.confidence + '; task/input samples: ' + estimate.distinct_task_inputs + '; peer models: ' + estimate.distinct_peer_models) + '</p><ul>' + estimate.tasks.map(task => '<li>Task estimate ' + escapeHTML(task.score.toFixed(2)) + '; opinion spread ' + escapeHTML(task.spread) + '<ul>' + task.votes.map(vote => '<li>' + escapeHTML(vote.reviewer_model + ': score ' + vote.score + ', weight ' + vote.weight.toFixed(3) + ', basis ' + vote.basis + ', record ' + vote.feedback_id) + '</li>').join('') + '</ul></li>').join('') + '</ul>';
  }).join('') + '<h3>Peer comments and working experience</h3><ul>' + profile.feedback.map(feedback => '<li>' + escapeHTML(feedback.reviewer.model_id + ': ' + feedback.summary) + (feedback.experience ? '<pre>' + escapeHTML(encode(feedback.experience)) + '</pre>' : '') + '<ul>' + feedback.evidence.map(reference => '<li>' + escapeHTML(reference.path + ': ' + reference.note + ' (hash: ' + (reference.sha256 ?? 'not supplied') + ')') + '</li>').join('') + '</ul></li>').join('') + '</ul></details>').join('');
  const operations = projection.operational_feedback.map(feedback => '<li>' + escapeHTML(feedback.subject.model_id + ' / ' + feedback.subject.route_id + ' / ' + feedback.attribution + ': ' + feedback.summary) + '</li>').join('');
  const source = history.source_path ? '<p>Imported source: <code>' + escapeHTML(history.source_path) + '</code><br>SHA-256: <code>' + escapeHTML(history.source_sha256) + '</code></p>' : '<p>No historical chart imported.</p>';
  return '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hakengaisya Staff Chart</title><style>body{font:15px/1.6 system-ui,Segoe UI,sans-serif;background:#f6f4ef;color:#1d1b17;max-width:1200px;margin:auto;padding:24px}h1{margin-bottom:0}small,.note{color:#605d55}section,details{background:#fffdf8;border:1px solid #d9d4c8;border-radius:8px;padding:18px;margin:18px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;border-bottom:1px solid #dedbd3;padding:10px;vertical-align:top}th:first-child{min-width:220px}code,pre{font:12px/1.5 Consolas,monospace;overflow-wrap:anywhere;white-space:pre-wrap}summary{cursor:pointer;font-weight:600}@media(prefers-color-scheme:dark){body{background:#15171a;color:#e8e5de}section,details{background:#1d2024;border-color:#34383e}th,td{border-color:#34383e}small,.note{color:#b0aca4}}</style>\n<body><h1>Hakengaisya Staff Chart</h1><p>Local working experience for software engineering and technical product work.</p><p class="note">Coordinator model: not connected. Survey plan: task hooks plus a periodic interval. No background polling is running.</p><section><h2>Contextual peer estimates</h2><p>Feedback records: ' + projection.received_records + '; capability contexts: ' + projection.profiles.length + '. Routine and complex work are shown separately. Unknown ability remains unmeasured.</p>' + (activeRows ? '<div class="scroll"><table>' + heading + activeRows + '</table></div>' : '<p>No new peer feedback has been recorded. Imported historical scores are shown below.</p>') + '</section>' + details + '<section><h2>Historical local reference</h2><p>These are the source chart author\'s historical estimates. Claimed observation counts and underlying evidence have not been verified. They provide discounted startup credibility, not new task samples or confirmed capability.</p>' + source + '<div class="scroll"><table>' + heading + legacyRows + '</table></div></section><section><h2>Route and environment experience</h2><p>Operational feedback is retained separately from model capability.</p><ul>' + (operations || '<li>No operational feedback recorded.</li>') + '</ul></section><section><h2>Method</h2><ul>' + DIMENSIONS.map(dimension => '<li>' + dimension + ': ' + escapeHTML(policy.dimensions[dimension]) + '</li>').join('') + '</ul><p>Each task gets a peer-weighted estimate. Distinct task/input estimates then have equal weight. Repeated comments from the same model on the same task replace earlier comments. Reviewer weights use a frozen credibility registry. Disagreement and weight provenance remain visible.</p><p>Policy: ' + escapeHTML(projection.policy_version) + '; registry epoch: ' + escapeHTML(projection.registry_epoch) + '. Peer estimates do not certify task acceptance and do not automatically assign work.</p></section></body></html>\n';
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'import-legacy' && args.length === 1) {
    const sourcePath = path.resolve(args[0]);
    const source = await readFile(sourcePath, 'utf8');
    const imported = importLegacyChart(source, sourcePath);
    const referenceRoot = path.dirname(path.dirname(sourcePath));
    imported.history.source_artifacts = [];
    for (const relative of ['harness/RUBRICS.md', 'harness/observation.schema.json']) {
      const filename = path.join(referenceRoot, relative);
      const bytes = await readFile(filename);
      imported.history.source_artifacts.push({ path: filename, sha256: digest(bytes.toString('utf8')) });
    }
    await immutableJSON(path.join(staff, 'imported', 'legacy-staff-chart.json'), imported.history);
    await immutableJSON(path.join(staff, 'registry.json'), imported.registry);
    console.log('Imported ' + imported.history.profiles.length + ' historical profile rows, ' + imported.registry.historical_seeds.length + ' model identities, ' + imported.history.historical_log.length + ' historical log rows. No raw observations or public benchmark scores imported.');
  } else if (command === 'record' && args.length === 1) {
    const feedback = validateFeedback(await readJSON(path.resolve(args[0])));
    await immutableJSON(path.join(staff, 'feedback', feedback.feedback_id + '.json'), feedback);
    console.log('Recorded peer feedback ' + feedback.feedback_id);
  } else if (command === 'survey' && args.length === 2) {
    const context = await readJSON(path.resolve(args[0]));
    const participants = await readJSON(path.resolve(args[1]));
    const plan = buildSurvey(context, participants);
    const filename = path.join(staff, 'surveys', 'plan-' + digest(plan).slice(0, 20) + '.json');
    await immutableJSON(filename, plan);
    console.log('Created ' + plan.requests.length + ' peer survey requests at ' + filename + '. No model calls executed.');
  } else if (command === 'build' && args.length === 0) {
    const policy = await readJSON(path.join(staff, 'policy.json'));
    const registry = await optionalJSON(path.join(staff, 'registry.json'), { schema_version: 1, epoch: 'unseeded', historical_seeds: [], local_capabilities: [] });
    const history = await optionalJSON(path.join(staff, 'imported', 'legacy-staff-chart.json'), { profiles: [] });
    const projection = aggregateFeedback(await feedbackRecords(), registry, policy);
    await mkdir(path.join(staff, 'projections'), { recursive: true });
    await writeFile(path.join(staff, 'projections', 'profiles.json'), encode(projection));
    const wiki = path.join(root, 'wiki');
    await mkdir(wiki, { recursive: true });
    await writeFile(path.join(wiki, 'index.html'), renderDashboard(projection, history, policy));
    console.log('Built staff projection and dashboard: ' + projection.profiles.length + ' new contexts; ' + history.profiles.length + ' historical rows.');
  } else {
    throw new Error('Usage: node scripts/staff.mjs import-legacy <chart.html> | record <feedback.json> | survey <context.json> <participants.json> | build');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
