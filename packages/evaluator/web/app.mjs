import { drawRadar } from './radar.mjs';

const element = (id) => document.getElementById(id);
function add(parent, tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  parent.append(node);
  return node;
}
async function api(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
let rows = [];
let definitions = [];
let detailRequest = 0;

function renderPublic(reference) {
  const target = element('public-content');
  target.replaceChildren();
  if (!reference) {
    add(target, 'p', 'No sourced public reference recorded for this model.');
    return;
  }
  add(target, 'p', reference.coarse_assessment);
  add(target, 'small', `${reference.source_type} | checked ${reference.checked_on}`);
  const link = add(target, 'a', reference.source_title);
  const url = new URL(reference.source_url);
  if (url.protocol === 'https:') {
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  const list = add(target, 'ul', '');
  for (const benchmark of reference.benchmarks) {
    const item = add(list, 'li', `${benchmark.name}: ${benchmark.value}`);
    add(item, 'small', benchmark.conditions);
  }
  add(target, 'p', reference.assessment_basis, 'muted');
  add(
    target,
    'p',
    'Public benchmark results are separate from the local radar. Test versions, effort levels, and harnesses can differ.',
    'muted',
  );
}

async function showDetail(row) {
  const request = ++detailRequest;
  const dialog = element('model-detail');
  element('detail-title').textContent = row.model_id;
  element('detail-status').textContent = 'Loading selected context';
  element('local-comments').replaceChildren();
  element('detail-dimensions').replaceChildren();
  element('public-content').replaceChildren();
  drawRadar(element('radar'), {});
  element('radar-note').textContent = 'Loading local scores';
  if (!dialog.open) dialog.showModal();
  try {
    const params = new URLSearchParams({
      model: row.model_id,
      kind: row.evaluation_kind,
      route: row.route,
      effort: row.effort,
      domain: row.domain,
      task_type: row.task_type,
      difficulty: row.difficulty,
    });
    if (element('skill').value) params.set('skill', element('skill').value);
    const detail = await api(`/api/v1/model-details?${params}`);
    if (request !== detailRequest) return;
    element('detail-status').textContent = [
      row.evaluation_kind,
      row.route,
      row.effort,
      row.difficulty,
      row.task_type,
    ].join(' / ');
    const shape = drawRadar(element('radar'), detail.radar);
    element('radar-note').textContent = shape.missing.length
      ? 'Not measured: ' +
        shape.missing.join(', ') +
        '. Missing dimensions are omitted, not drawn as zero.'
      : 'All six dimensions have scores in this selected evidence layer; scale 0-10.';
    for (const definition of definitions) {
      add(element('detail-dimensions'), 'dt', `${definition.id} ${definition.name}`);
      const support = [
        ...new Set(detail.profiles.map((profile) => profile.dimensions[definition.id].support)),
      ].join(', ');
      add(
        element('detail-dimensions'),
        'dd',
        (detail.radar[definition.id] ?? 'not measured') + (support ? ` / ${support}` : ''),
      );
    }
    const target = element('local-comments');
    if (!detail.comments.length) add(target, 'p', 'No local comments in this selected context.');
    for (const comment of detail.comments) {
      const article = add(target, 'article', '');
      add(article, 'p', comment.comment);
      add(article, 'p', `Example: ${comment.example}`);
      add(article, 'p', `Guidance: ${comment.guidance}`);
    }
    renderPublic(detail.public_reference);
  } catch (error) {
    if (request === detailRequest) element('detail-status').textContent = error.message;
  }
}

element('close-detail').onclick = () => {
  detailRequest += 1;
  element('model-detail').close();
};
element('model-detail').addEventListener('cancel', () => {
  detailRequest += 1;
});
function render() {
  const key = element('sort').value;
  const sorted = [...rows].sort((a, b) =>
    a[key] === null
      ? b[key] === null
        ? 0
        : 1
      : b[key] === null
        ? -1
        : key === 'display_score'
          ? b[key] - a[key]
          : a[key] - b[key],
  );
  const target = element('ranking');
  target.replaceChildren();
  element('empty').hidden = sorted.length > 0;
  for (const [index, row] of sorted.entries()) {
    const tr = add(target, 'tr', '');
    add(tr, 'td', index + 1);
    const model = add(tr, 'td', '');
    const button = add(model, 'button', row.model_id, 'model-link');
    button.onclick = () => showDetail(row);
    add(model, 'small', `${row.route} / ${row.effort}`);
    add(tr, 'td', row.tags.join(', '));
    add(tr, 'td', row.difficulty);
    add(tr, 'td', row.display_score ?? 'not measured');
    for (const dimension of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'])
      add(tr, 'td', row.dimensions[dimension] ?? '-');
    add(tr, 'td', row.cost_usd === null ? 'unknown' : `$${row.cost_usd}`);
    add(tr, 'td', row.wall_seconds === null ? 'unknown' : `${row.wall_seconds}s`);
    const reference = add(tr, 'td', '', 'public-reference');
    if (row.public_reference) {
      add(reference, 'span', row.public_reference.coarse_assessment);
      const first = row.public_reference.benchmarks[0];
      if (first) add(reference, 'small', `${first.name}: ${first.value}`);
    } else add(reference, 'span', 'No sourced public reference');
  }
}
async function refresh() {
  element('status').textContent = 'Loading';
  try {
    const params = new URLSearchParams({ kind: element('kind').value });
    if (element('skill').value) params.set('skill', element('skill').value);
    if (element('difficulty').value) params.set('difficulty', element('difficulty').value);
    const data = await api(`/api/v1/rankings?${params}`);
    rows = data.rows;
    render();
    element('status').textContent = `${rows.length} ranking rows`;
  } catch (error) {
    element('status').textContent = error.message;
  }
}
element('refresh').onclick = refresh;
element('kind').onchange = refresh;
element('skill').onchange = refresh;
element('difficulty').onchange = refresh;
element('sort').onchange = render;
try {
  const taxonomy = await api('/api/v1/taxonomy');
  definitions = taxonomy.dimension_definitions;
  for (const definition of definitions) {
    add(element('dimension-list'), 'dt', `${definition.id} ${definition.name}`);
    add(element('dimension-list'), 'dd', definition.evaluates);
  }
  for (const skill of taxonomy.skills) {
    const option = add(element('skill'), 'option', skill);
    option.value = skill;
  }
  await refresh();
} catch (error) {
  element('status').textContent = error.message;
}
