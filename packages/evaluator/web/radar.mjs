export const RADAR_DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
export function radarGeometry(scores) {
  const center = [180, 166];
  const radius = 112;
  const point = (index, fraction) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 3;
    return [
      center[0] + Math.cos(angle) * radius * fraction,
      center[1] + Math.sin(angle) * radius * fraction,
    ];
  };
  const points = RADAR_DIMENSIONS.map((id, index) => {
    const score = scores[id] ?? null;
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 10))
      throw new Error('Invalid radar score');
    return {
      id,
      score,
      position: score === null ? null : point(index, score / 10),
      axis: point(index, 1),
      label: point(index, 1.22),
    };
  });
  return {
    center,
    points,
    rings: [2, 4, 6, 8, 10].map((value) => ({
      value,
      points: RADAR_DIMENSIONS.map((_, index) => point(index, value / 10)),
    })),
    complete: points.every((item) => item.score !== null),
    missing: points.filter((item) => item.score === null).map((item) => item.id),
  };
}
export function drawRadar(svg, scores) {
  const shape = radarGeometry(scores);
  svg.replaceChildren();
  const create = (tag, attributes, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  svg.setAttribute('viewBox', '0 0 360 332');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    'Six-dimensional local ability: ' +
      shape.points.map((item) => `${item.id} ${item.score ?? 'not measured'}`).join(', '),
  );
  for (const ring of shape.rings) {
    create('polygon', {
      points: ring.points.map((point) => point.join(',')).join(' '),
      class: 'radar-grid',
    });
    create(
      'text',
      { x: 185, y: shape.center[1] - (112 * ring.value) / 10 - 3, class: 'radar-tick' },
      ring.value,
    );
  }
  for (const item of shape.points) {
    create('line', {
      x1: shape.center[0],
      y1: shape.center[1],
      x2: item.axis[0],
      y2: item.axis[1],
      class: 'radar-grid',
    });
    create(
      'text',
      { x: item.label[0], y: item.label[1] + 5, 'text-anchor': 'middle', class: 'radar-label' },
      item.id,
    );
  }
  if (shape.complete)
    create('polygon', {
      points: shape.points.map((item) => item.position.join(',')).join(' '),
      class: 'radar-area',
    });
  else
    for (let index = 0; index < shape.points.length; index += 1) {
      const current = shape.points[index];
      const next = shape.points[(index + 1) % 6];
      if (current.position && next.position)
        create('line', {
          x1: current.position[0],
          y1: current.position[1],
          x2: next.position[0],
          y2: next.position[1],
          class: 'radar-segment',
        });
    }
  for (const item of shape.points)
    if (item.position) {
      const node = create('circle', {
        cx: item.position[0],
        cy: item.position[1],
        r: 4,
        class: 'radar-point',
      });
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${item.id}: ${item.score}`;
      node.append(title);
    }
  return shape;
}
