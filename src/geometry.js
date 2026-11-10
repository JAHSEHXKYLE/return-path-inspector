const EPS = 1e-7;
const SNAP = 0.02; // mil
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const at = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const clamp = t => Math.max(0, Math.min(1, t));
const point = (x, y) => ({ x, y });
const validPoint = p => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const keyOf = (p, layer) => [layer, Math.round(p.x / SNAP), Math.round(p.y / SNAP)].join(':');

function project(p, a, b) {
  const x = b.x - a.x, y = b.y - a.y;
  const t = clamp(((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1));
  return { t, p: at(a, b, t) };
}

function intersections(a, b, c, d) {
  const x = b.x - a.x, y = b.y - a.y, u = d.x - c.x, v = d.y - c.y;
  const div = cross(x, y, u, v), wx = c.x - a.x, wy = c.y - a.y;
  if (Math.abs(div) > EPS) {
    const t = cross(wx, wy, u, v) / div, s = cross(wx, wy, x, y) / div;
    return t >= -EPS && t <= 1 + EPS && s >= -EPS && s <= 1 + EPS ? [clamp(t)] : [];
  }
  if (Math.abs(cross(wx, wy, x, y)) > EPS) return [];
  const len = x * x + y * y;
  if (!len) return [];
  const t = (wx * x + wy * y) / len, s = ((d.x - a.x) * x + (d.y - a.y) * y) / len;
  const lo = Math.max(0, Math.min(t, s)), hi = Math.min(1, Math.max(t, s));
  return lo <= hi + EPS ? [clamp(lo), clamp(hi)] : [];
}

function ringEdges(ring) {
  return ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);
}

function polygonState(p, edges) {
  let winding = 0;
  for (const [a, b] of edges) {
    const area = cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y);
    if (Math.abs(area) <= EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
      && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS) return { boundary: true, winding: 0 };
    if (a.y <= p.y && b.y > p.y && area > 0) winding++;
    if (a.y > p.y && b.y <= p.y && area < 0) winding--;
  }
  return { boundary: false, winding };
}

function cuts(a, b, edges) {
  const values = [0, 1];
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
  const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y);
  for (const [c, d] of edges) {
    if (Math.max(c.x, d.x) < left - EPS || Math.min(c.x, d.x) > right + EPS ||
        Math.max(c.y, d.y) < low - EPS || Math.min(c.y, d.y) > high + EPS) continue;
    values.push(...intersections(a, b, c, d));
  }
  return uniqueSorted(values);
}

function uniqueSorted(values) {
  return values.sort((a, b) => a - b).filter((t, i) => !i || t - values[i - 1] > EPS);
}

function segmentIn(a, b, edges, contains) {
  if (!contains(a) || !contains(b)) return false;
  const ts = cuts(a, b, edges);
  return ts.slice(1).every((t, i) => contains(at(a, b, (t + ts[i]) / 2)));
}

function cleanRing(points) {
  const ring = points.filter((p, i) => !i || distance(p, points[i - 1]) > EPS);
  if (ring.length > 1 && distance(ring[0], ring.at(-1)) <= SNAP) ring.pop();
  return ring;
}

function sealBoard(paths, cutouts = []) {
  const pending = paths.filter(path => path.length > 1).map(path => path.slice());
  const rings = [];
  while (pending.length) {
    const chain = pending.pop();
    while (distance(chain[0], chain.at(-1)) > SNAP) {
      const end = chain.at(-1);
      const matches = pending.map((path, index) => ({
        index, head: distance(end, path[0]) <= SNAP, tail: distance(end, path.at(-1)) <= SNAP,
      })).filter(match => match.head || match.tail);
      if (matches.length !== 1 || (matches[0].head && matches[0].tail)) {
        throw new Error('板框未闭合，或接头存在分叉。异常接头坐标 (' + end.x.toFixed(2) + ', ' +
          end.y.toFixed(2) + ') mil，可连接轮廓段数 ' + matches.length + '。');
      }
      const match = matches[0], next = pending.splice(match.index, 1)[0];
      chain.push(...(match.head ? next : next.reverse()).slice(1));
    }
    const ring = cleanRing(chain);
    if (ring.length < 3) throw new Error('板框退化，无法确认封闭板区。');
    rings.push(ring);
  }
  if (!rings.length) throw new Error('找不到闭合板框。请在板框层绘制完整外轮廓。');
  const contours = rings.map(ringEdges);
  const holes = cutouts.map(ringEdges);
  const edges = contours.flat();
  let checked = 0;
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const [a, b] = contour[i];
      if (distance(a, b) <= EPS) throw new Error('板框含重复或退化线段。');
      for (let j = i + 2; j < contour.length; j++) {
        if (i === 0 && j === contour.length - 1) continue;
        if (++checked > 2000000) throw new Error('板框过于复杂，无法可靠校验闭合性。');
        if (intersections(a, b, ...contour[j]).length) throw new Error('板框自相交，无法确认封闭板区。');
      }
    }
  }
  for (let i = 0; i < contours.length; i++) {
    for (let j = i + 1; j < contours.length; j++) {
      for (const [a, b] of contours[i]) {
        for (const edge of contours[j]) {
          if (++checked > 2000000) throw new Error('板框过于复杂，无法可靠校验闭合性。');
          if (intersections(a, b, ...edge).length) throw new Error('板框轮廓接触或相交，无法区分板区。');
        }
      }
    }
  }
  const area = ring => Math.abs(ringEdges(ring).reduce((sum, [a, b]) => sum + cross(a.x, a.y, b.x, b.y), 0));
  const areas = rings.map(area);
  if (areas.some(value => value <= EPS)) throw new Error('板框面积为零，无法确认封闭板区。');

  function island(p) {
    if (holes.some(hole => {
      const state = polygonState(p, hole);
      return state.boundary || state.winding;
    })) return -1;
    const states = contours.map(contour => polygonState(p, contour));
    if (states.some(state => state.boundary)) return -1;
    const inside = states.map((state, i) => state.winding ? i : -1).filter(i => i >= 0);
    if (inside.length % 2 === 0) return -1;
    return inside.reduce((a, b) => areas[a] < areas[b] ? a : b);
  }
  return { island, edges: [...edges, ...holes.flat()] };
}

function validateEnds(start, end, board) {
  if (!start.net || !end.net || start.net !== end.net) {
    throw new Error('起始点和流入点网络不同或未分配网络（' + (start.net || '无网络') + ' / ' + (end.net || '无网络') + '）。未计算。');
  }
  const region = board.island(start.p);
  if (region < 0 || board.island(end.p) !== region) {
    throw new Error('两点必须在同一个闭合板框内，且不能落在边界或槽孔中。未计算。');
  }
  if (start.id === end.id && distance(start.p, end.p) < SNAP) {
    throw new Error('起始点和流入点重合。请选择两个不同的位置。');
  }
  return p => board.island(p) === region;
}

function arcPoints(a, b, degrees, subdivisions = 1) {
  const angle = degrees * Math.PI / 180, chord = distance(a, b);
  if (Math.abs(angle) < EPS || chord < EPS) return { points: [a, b], scale: 1 };
  if (!Number.isFinite(angle) || Math.abs(angle) >= Math.PI * 2) throw new Error('无法解析圆弧。');
  const offset = chord / (2 * Math.tan(angle / 2));
  const center = point((a.x + b.x) / 2 - (b.y - a.y) / chord * offset, (a.y + b.y) / 2 + (b.x - a.x) / chord * offset);
  const radius = distance(center, a), phase = Math.atan2(a.y - center.y, a.x - center.x);
  const maxAngle = Math.min(Math.PI / 18, 2 * Math.acos(Math.max(-1, 1 - 0.05 / radius)));
  const baseSteps = Math.max(2, Math.ceil(Math.abs(angle) / maxAngle));
  if (baseSteps > 1500) throw new Error('圆弧离散复杂度超过上限。');
  const steps = Math.min(1500, baseSteps * subdivisions);
  const points = [a];
  for (let i = 1; i < steps; i++) {
    const theta = phase + angle * i / steps;
    points.push(point(center.x + radius * Math.cos(theta), center.y + radius * Math.sin(theta)));
  }
  points.push(b);
  const stepAngle = Math.abs(angle) / steps;
  return { points, scale: stepAngle / (2 * Math.sin(stepAngle / 2)) };
}

class MinHeap {
  items = [];
  get size() { return this.items.length; }
  push(value, rank) {
    const list = this.items, entry = { value, rank };
    let i = list.length;
    list.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (list[parent].rank <= rank) break;
      list[i] = list[parent];
      i = parent;
    }
    list[i] = entry;
  }
  pop() {
    const list = this.items, first = list[0], last = list.pop();
    if (list.length) {
      let i = 0;
      while (2 * i + 1 < list.length) {
        let child = 2 * i + 1;
        if (child + 1 < list.length && list[child + 1].rank < list[child].rank) child++;
        if (list[child].rank >= last.rank) break;
        list[i] = list[child];
        i = child;
      }
      list[i] = last;
    }
    return first;
  }
}

class RouteGraph {
  nodes = [];
  keys = new Map();
  edgeKeys = new Set();
  node(p, layer) {
    const key = keyOf(p, layer);
    if (!this.keys.has(key)) {
      this.keys.set(key, this.addNode(p, layer));
    }
    return this.keys.get(key);
  }
  addNode(p, layer) {
    return this.nodes.push({ p, layer, edges: [] }) - 1;
  }
  connect(a, b, length, kind, path, layers, plane = '', radius = 0) {
    if (a === b) return;
    const key = [Math.min(a, b), Math.max(a, b), kind, plane].join('|');
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.nodes[a].edges.push({ to: b, length, kind, path, layers, plane, radius });
    this.nodes[b].edges.push({ to: a, length, kind, path: path.slice().reverse(), layers: layers.slice().reverse(), plane, radius });
  }
}

function* shortestDistances(graph, start) {
  const distances = new Float64Array(graph.nodes.length).fill(Infinity);
  distances[start] = 0;
  const queue = new MinHeap();
  queue.push(start, 0);
  let visited = 0;
  while (queue.size) {
    if (++visited % 512 === 0) yield '枚举并排序候选路径';
    const { value: id, rank: cost } = queue.pop();
    if (cost > distances[id]) continue;
    for (const edge of graph.nodes[id].edges) {
      const next = cost + edge.length;
      if (next >= distances[edge.to]) continue;
      distances[edge.to] = next;
      queue.push(edge.to, next);
    }
  }
  return distances;
}

function* enumerateRoutes(graph, start, end, maxRoutes = 100, finishRoute) {
  const remaining = yield* shortestDistances(graph, end);
  if (!Number.isFinite(remaining[start])) return { routes: [], truncated: false };
  const queue = new MinHeap();
  const routes = [];
  let deadline = Date.now() + 1300;
  const endpointVias = [start, end].filter(id => graph.nodes[id].edges.length > 1)
    .map(id => graph.nodes[id].p);
  queue.push({ id: start, cost: 0, via: null, prev: null }, remaining[start]);
  let expanded = 0;
  while (queue.size) {
    if (++expanded > 60000 || Date.now() > deadline || queue.size > 60000) return { routes, truncated: true };
    if (expanded % 128 === 0) {
      const pause = Date.now();
      yield '枚举并排序候选路径';
      deadline += Date.now() - pause;
    }
    const { value: state } = queue.pop();
    if (state.id === end) {
      if (routes.length === maxRoutes) return { routes, truncated: true };
      const edges = [];
      for (let item = state; item.via; item = item.prev) {
        if (item.via.kind !== 'endpoint') edges.push(item.via);
      }
      edges.reverse();
      const route = finishRoute ? finishRoute(edges) : { length: state.cost, edges };
      if (route) routes.push(route);
      continue;
    }
    const visited = new Set();
    for (let item = state; item; item = item.prev) visited.add(item.id);
    for (const edge of graph.nodes[state.id].edges) {
      if (visited.has(edge.to) || !Number.isFinite(remaining[edge.to])) continue;
      if (edge.kind === 'plane' && edge.plane && edge.plane === state.via?.plane && state.via.kind === 'plane') continue;
      if (edge.kind === 'via' && endpointVias.some(p => distance(p, edge.path[0]) <= SNAP)) continue;
      const cost = state.cost + edge.length;
      queue.push({ id: edge.to, cost, via: edge, prev: state }, cost + remaining[edge.to]);
    }
  }
  return { routes, truncated: false };
}

function routeWithinPlane(graph, plane, board, insideBoard, ports) {
  if (ports.size < 2) return true;
  const vertices = [...ports.values()], idSet = new Set([...ports.keys()]);
  const seen = new Set(vertices.map(p => keyOf(p, plane.layer)));
  for (const p of plane.rings.flat()) {
    const key = keyOf(p, plane.layer);
    if (seen.has(key) || !insideBoard(p)) continue;
    seen.add(key);
    vertices.push(p);
  }
  if (vertices.length > 210 || ports.size > 56) return false;
  const edges = vertices.map(() => []);
  const planeEdges = plane.rings.flatMap(ringEdges);
  const boundary = planeEdges.concat(board.edges);
  const contains = p => insideBoard(p) && inCopper(p, planeEdges);
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (!segmentIn(vertices[i], vertices[j], boundary, contains)) continue;
      const length = distance(vertices[i], vertices[j]);
      edges[i].push([j, length]);
      edges[j].push([i, length]);
    }
  }
  const portIds = [...idSet], links = [];
  for (let i = 0; i < portIds.length; i++) {
    const dist = new Float64Array(vertices.length).fill(Infinity);
    const previous = new Int32Array(vertices.length).fill(-1);
    const queue = new MinHeap();
    dist[i] = 0;
    queue.push(i, 0);
    while (queue.size) {
      const { value: from, rank } = queue.pop();
      if (rank > dist[from]) continue;
      for (const [to, weight] of edges[from]) {
        const candidate = rank + weight;
        if (candidate + EPS >= dist[to]) continue;
        dist[to] = candidate;
        previous[to] = from;
        queue.push(to, candidate);
      }
    }
    for (let j = i + 1; j < portIds.length; j++) {
      if (!Number.isFinite(dist[j])) continue;
      const path = [];
      for (let cursor = j; cursor !== -1; cursor = previous[cursor]) path.push(vertices[cursor]);
      links.push([portIds[i], portIds[j], dist[j], path.reverse()]);
    }
  }
  for (const [a, b, length, path] of links) {
    graph.connect(a, b, length, 'plane', path, [plane.layer], plane.id);
  }
  return true;
}

const minX = edge => Math.min(edge[0].x, edge[1].x);
const maxX = edge => Math.max(edge[0].x, edge[1].x);
const minY = edge => Math.min(edge[0].y, edge[1].y);
const maxY = edge => Math.max(edge[0].y, edge[1].y);

function boundsOf(edges) {
  return edges.reduce((box, edge) => ({
    left: Math.min(box.left, minX(edge)), right: Math.max(box.right, maxX(edge)),
    bottom: Math.min(box.bottom, minY(edge)), top: Math.max(box.top, maxY(edge)),
  }), { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity });
}

function copperContains(edges, box) {
  const count = 64;
  const height = (box.top - box.bottom) / count;
  if (edges.length < 128 || height <= EPS) return p => inCopper(p, edges);
  const rows = Array.from({ length: count }, () => []);
  const index = y => Math.min(count - 1, Math.max(0, Math.floor((y - box.bottom) / height)));
  for (const edge of edges) {
    const last = index(maxY(edge) + EPS);
    for (let row = index(minY(edge) - EPS); row <= last; row++) rows[row].push(edge);
  }
  return p => p.x >= box.left - EPS && p.x <= box.right + EPS &&
    p.y >= box.bottom - EPS && p.y <= box.top + EPS && inCopper(p, rows[index(p.y)]);
}

function overlaps(a, b) {
  return a.left <= b.right + EPS && b.left <= a.right + EPS &&
    a.bottom <= b.top + EPS && b.bottom <= a.top + EPS;
}

function* copperMesh(graph, plane, copperEdges, board, inside, ports) {
  if (ports.size < 2) return true;
  const box = boundsOf(copperEdges);
  const boardEdges = board.edges.filter(edge => overlaps(box, boundsOf([edge])));
  const boundaries = [];
  const breaks = [];
  for (const [edges, copper] of [[copperEdges, true], [boardEdges, false]]) {
    for (const [a, b] of edges) {
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      breaks.push(Math.max(box.left, left), Math.min(box.right, right));
      if (right - left <= EPS) continue;
      const slope = (b.y - a.y) / (b.x - a.x);
      boundaries.push({
        left, right, y: x => a.y + (x - a.x) * slope,
        change: copper ? Math.sign(b.x - a.x) : 0,
      });
    }
  }
  for (const edge of boardEdges) {
    const limit = boundsOf([edge]);
    for (const [a, b] of copperEdges) {
      if (Math.max(a.x, b.x) < limit.left - EPS || Math.min(a.x, b.x) > limit.right + EPS ||
          Math.max(a.y, b.y) < limit.bottom - EPS || Math.min(a.y, b.y) > limit.top + EPS) continue;
      for (const t of intersections(a, b, ...edge)) breaks.push(at(a, b, t).x);
    }
  }
  const xs = uniqueSorted(breaks);
  const ordered = boundaries.sort((a, b) => a.left - b.left);
  const slabs = [];
  let next = 0, active = [], cells = 0, work = 0;
  let insideRegion;
  const onBoard = boardEdges.length ? inside : p => (insideRegion ??= inside(p));
  for (let i = 1; i < xs.length; i++) {
    if (i % 64 === 0) yield '搜索覆铜绕行路线';
    const x = (xs[i - 1] + xs[i]) / 2;
    active = active.filter(edge => edge.right > x);
    while (next < ordered.length && ordered[next].left < x) {
      const edge = ordered[next++];
      if (edge.right > x) active.push(edge);
    }
    work += active.length;
    if (work > 3000000) return false;
    const crossings = active.map(edge => ({ edge, y: edge.y(x) })).sort((a, b) => a.y - b.y);
    let winding = 0;
    const slab = [];
    for (let j = 1; j < crossings.length; j++) {
      const low = crossings[j - 1], high = crossings[j];
      winding += low.edge.change;
      if (!winding || high.y - low.y <= EPS) continue;
      const center = point(x, (low.y + high.y) / 2);
      if (!onBoard(center)) continue;
      const previous = slab.at(-1);
      if (previous && previous.top === low.edge) {
        previous.top = high.edge;
        previous.center.y = (previous.bottom.y(x) + high.y) / 2;
      } else {
        slab.push({ bottom: low.edge, top: high.edge, center });
      }
    }
    cells += slab.length;
    if (cells > 60000) return false;
    slabs.push(slab);
  }

  const { id, layer } = plane;
  for (const slab of slabs) for (const cell of slab) cell.node = graph.addNode(cell.center, layer);
  for (let i = 1; i < slabs.length; i++) {
    if (i % 64 === 0) yield '搜索覆铜绕行路线';
    const x = xs[i], left = slabs[i - 1], right = slabs[i];
    let j = 0, k = 0;
    while (j < left.length && k < right.length) {
      const a = left[j], b = right[k], aTop = a.top.y(x), bTop = b.top.y(x);
      const low = Math.max(a.bottom.y(x), b.bottom.y(x)), high = Math.min(aTop, bTop);
      if (high - low > EPS) {
        const gate = point(x, (low + high) / 2);
        if (onBoard(gate)) graph.connect(a.node, b.node, distance(a.center, gate) + distance(gate, b.center),
          'mesh', [a.center, gate, b.center], [layer], id);
      }
      if (aTop <= bTop + EPS) j++;
      if (bTop <= aTop + EPS) k++;
    }
  }
  for (const [port, p] of ports) {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < p.x - EPS) lo = mid + 1;
      else hi = mid;
    }
    for (const index of [lo - 1, lo]) {
      if (!slabs[index] || p.x < xs[index] - EPS || p.x > xs[index + 1] + EPS) continue;
      for (const cell of slabs[index]) {
        if (p.y < cell.bottom.y(p.x) - EPS || p.y > cell.top.y(p.x) + EPS) continue;
        graph.connect(port, cell.node, distance(p, cell.center), 'mesh', [p, cell.center], [layer], id);
      }
    }
  }
  return true;
}

const CHAMFER_MARGIN = 0.05; // mil of trim before the first boundary contact
const SHORT_MIDDLE_DIVISOR = 4;
const COPPER_REFINEMENT_BUDGET = 2000000;

// Express a boundary edge in the basis of the two rays leaving the corner.
// A chord at trim d sweeps the triangle with u >= 0, v >= 0 and u + v <= d.
function chamferContact(a, b, corner, back, ahead, determinant) {
  const coordinates = p => {
    const x = p.x - corner.x, y = p.y - corner.y;
    return [cross(x, y, ahead.x, ahead.y) / determinant, cross(back.x, back.y, x, y) / determinant];
  };
  const start = coordinates(a), end = coordinates(b);
  let enter = 0, exit = 1;
  for (let i = 0; i < 2; i++) {
    const low = start[i], high = end[i];
    // Ignore edges lying along a leg. They do not enter the swept interior.
    if (low <= EPS && high <= EPS) return Infinity;
    if (low <= EPS) enter = Math.max(enter, (EPS - low) / (high - low));
    if (high <= EPS) exit = Math.min(exit, (EPS - low) / (high - low));
  }
  if (enter >= exit) return Infinity;
  const sum = start[0] + start[1], change = end[0] + end[1] - sum;
  return sum + change * (change >= 0 ? enter : exit);
}

function chamferCorner(a, corner, b, boundary, contains, budget) {
  const before = distance(a, corner), after = distance(corner, b);
  const maxTrim = Math.min(before, after);
  if (maxTrim < CHAMFER_MARGIN) return null;
  const back = point((a.x - corner.x) / before, (a.y - corner.y) / before);
  const ahead = point((b.x - corner.x) / after, (b.y - corner.y) / after);
  const determinant = cross(back.x, back.y, ahead.x, ahead.y);
  if (Math.abs(determinant) <= EPS || back.x * ahead.x + back.y * ahead.y <= -Math.SQRT1_2) return null;
  if (!reserveRefinementWork(budget, boundary.length)) return null;

  const from = d => at(corner, a, d / before);
  const to = d => at(corner, b, d / after);
  const box = boundsOf([[corner, from(maxTrim)], [corner, to(maxTrim)]]);
  const nearby = boundary.filter(edge => maxX(edge) >= box.left - EPS && minX(edge) <= box.right + EPS &&
    maxY(edge) >= box.bottom - EPS && minY(edge) <= box.top + EPS);
  let trim = maxTrim;
  for (const [start, end] of nearby) {
    const contact = chamferContact(start, end, corner, back, ahead, determinant);
    trim = Math.min(trim, contact - CHAMFER_MARGIN);
  }
  if (trim < CHAMFER_MARGIN) return null;
  // Validate the entire new chord, including endpoints and all boundary intervals.
  const legal = d => segmentIn(from(d), to(d), nearby, contains);
  if (!legal(trim)) {
    let low = 0, high = trim;
    while (high - low > CHAMFER_MARGIN) {
      const mid = (low + high) / 2;
      if (legal(mid)) low = mid;
      else high = mid;
    }
    trim = low;
    if (trim < CHAMFER_MARGIN) return null;
  }
  return [from(trim), to(trim)];
}

function reserveRefinementWork(budget, cost) {
  if (budget.remaining < cost) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= cost;
  return true;
}

function removeShortMiddleSegments(path, boundary, contains, budget, divisor) {
  let removed = false;
  for (let i = 0; i + 3 < path.length;) {
    const a = path[i], b = path[i + 1], c = path[i + 2], d = path[i + 3];
    const outerLength = distance(a, b) + distance(c, d);
    const middleLength = distance(b, c);
    if (middleLength < outerLength / divisor && distance(a, d) + EPS < outerLength + middleLength) {
      if (!reserveRefinementWork(budget, boundary.length)) break;
      if (segmentIn(a, d, boundary, contains)) {
        path.splice(i + 1, 2);
        removed = true;
        i = Math.max(0, i - 2);
        continue;
      }
    }
    i++;
  }
  return removed;
}

function refineCopperPath(path, boundary, contains, budget, divisor = SHORT_MIDDLE_DIVISOR) {
  // Subsequent passes can refine corners that become reachable after a cut or merge.
  for (let pass = 0; pass < 4 && path.length > 2; pass++) {
    let chamfered = false;
    for (let i = 1; i < path.length - 1 && !budget.exhausted; i++) {
      const a = path[i - 1], b = path[i + 1];
      const chord = chamferCorner(a, path[i], b, boundary, contains, budget);
      if (!chord) continue;
      const points = chord.filter(p => distance(p, a) > EPS && distance(p, b) > EPS);
      path.splice(i, 1, ...points);
      chamfered = true;
      i += points.length - 1;
    }
    if (budget.exhausted) break;
    const removed = removeShortMiddleSegments(path, boundary, contains, budget, divisor);
    if (budget.exhausted || (!chamfered && !removed)) break;
  }
  return path;
}

function mergeMeshRoute(edges, meshPlanes, inside, budget) {
  const result = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (edge.kind !== 'mesh') {
      result.push(edge);
      continue;
    }
    const points = edge.path.slice();
    while (edges[i + 1]?.kind === 'mesh' && edges[i + 1].plane === edge.plane) {
      points.push(...edges[++i].path.slice(1));
    }
    const region = meshPlanes.get(edge.plane);
    const contains = p => inside(p) && region.contains(p);
    const path = [points[0]];
    for (let from = 0; from < points.length - 1;) {
      let to = points.length - 1;
      while (!segmentIn(points[from], points[to], region.boundary, contains)) {
        if (to === from + 1) return null;
        to = from + Math.ceil((to - from) / 2);
      }
      path.push(points[to]);
      from = to;
    }
    refineCopperPath(path, region.boundary, contains, budget);
    const length = path.slice(1).reduce((sum, p, j) => sum + distance(path[j], p), 0);
    result.push({ ...edge, kind: 'plane', path, length });
  }
  return { edges: result, length: result.reduce((sum, edge) => sum + edge.length, 0) };
}

function roundedPreviewCorner(a, corner, b, incoming, outgoing, subdivisions, maxTrim, board, regions) {
  const before = distance(a, corner), after = distance(corner, b);
  const dot = (corner.x - a.x) * (b.x - corner.x) + (corner.y - a.y) * (b.y - corner.y);
  if (dot >= 0.975 * before * after) return [corner];
  const region = incoming.plane && incoming.plane === outgoing.plane ? regions.get(incoming.plane) : undefined;
  // Two track endpoints with known radii share a copper disk at the corner.
  const trackTrim = Math.min(incoming.radius || 0, outgoing.radius || 0);
  let trim = Math.min(before * 0.4, after * 0.4, maxTrim, region ? Infinity : trackTrim);
  if (trim < SNAP) return [corner];
  const island = board.island(corner);
  if (island < 0) return [corner];
  const contains = p => board.island(p) === island && (!region || region.contains(p));
  const boundary = region?.boundary || board.edges;
  const box = boundsOf([[corner, at(corner, a, trim / before)], [corner, at(corner, b, trim / after)]]);
  const nearby = boundary.filter(edge => maxX(edge) >= box.left - EPS && minX(edge) <= box.right + EPS &&
    maxY(edge) >= box.bottom - EPS && minY(edge) <= box.top + EPS);
  for (let attempt = 0; attempt < 8 && trim >= SNAP; attempt++, trim /= 2) {
    const entry = at(corner, a, trim / before), exit = at(corner, b, trim / after);
    const curve = Array.from({ length: subdivisions + 1 }, (_, i) => {
      const t = i / subdivisions;
      return at(at(entry, corner, t), at(corner, exit, t), t);
    });
    if (curve.slice(1).every((p, i) => segmentIn(curve[i], p, nearby, contains))) return curve;
  }
  return [corner];
}

function buildRoutePreview(route, visible, density, board, regions) {
  const paths = [], vias = [];
  if (!route?.edges.length) return { paths, vias };
  const points = route.edges.flatMap(edge => edge.path);
  const box = boundsOf(points.map(p => [p, p]));
  const span = Math.max(box.right - box.left, box.top - box.bottom, 1);
  const partEnds = new Set();
  let offset = 0;
  for (const part of route.parts || []) {
    offset += part.edgeCount;
    partEnds.add(offset);
  }
  let run = [], sources = [], layer;
  const flush = () => {
    if (run.length > 1) {
      const rounded = [run[0]];
      for (let i = 1; i < run.length - 1; i++) {
        rounded.push(...roundedPreviewCorner(run[i - 1], run[i], run[i + 1], sources[i - 1], sources[i],
          density * 3, span * 0.04, board, regions));
      }
      rounded.push(run.at(-1));
      paths.push({ layer, points: rounded });
    }
    run = [];
    sources = [];
  };
  const seenVias = new Set();
  for (const [i, edge] of route.edges.entries()) {
    const id = edge.layers[0];
    const show = edge.kind !== 'via' && edge.path.length > 1 && visible(id);
    if (run.length && (!show || id !== layer || partEnds.has(i) || distance(run.at(-1), edge.path[0]) > EPS)) flush();
    if (show) {
      if (!run.length) run.push(edge.path[0]);
      for (const p of edge.path.slice(1)) {
        if (distance(run.at(-1), p) <= EPS) continue;
        run.push(p);
        sources.push(edge);
      }
      layer = id;
    } else if (edge.kind === 'via') {
      const viaLayer = edge.layers.find(visible);
      const p = edge.path[0], key = keyOf(p, '');
      if (viaLayer == null || seenVias.has(key)) continue;
      seenVias.add(key);
      vias.push({ layer: viaLayer, p, r: Math.max(40, span) * 0.013 });
    }
  }
  flush();
  return { paths, vias };
}

function inCopper(p, edges) {
  const state = polygonState(p, edges);
  return state.boundary || state.winding !== 0;
}

function closestSegments(a, b, c, d) {
  const candidates = [
    [a, project(a, c, d).p], [b, project(b, c, d).p],
    [project(c, a, b).p, c], [project(d, a, b).p, d],
  ];
  return candidates.reduce((best, pair) => distance(...pair) < distance(...best) ? pair : best);
}

function trackCopperContact(segment, edges, reach) {
  const { a, b } = segment;
  const box = { left: Math.min(a.x, b.x) - reach, right: Math.max(a.x, b.x) + reach,
    bottom: Math.min(a.y, b.y) - reach, top: Math.max(a.y, b.y) + reach };
  let best, gap = reach + EPS;
  for (const edge of edges) {
    if (maxX(edge) < box.left || minX(edge) > box.right || maxY(edge) < box.bottom || minY(edge) > box.top) continue;
    const pair = closestSegments(a, b, ...edge);
    const d = distance(...pair);
    if (d >= gap) continue;
    gap = d;
    best = pair;
  }
  return best;
}

function copperContact(anchor, edges, stroke = 0) {
  const outline = anchor.outline ? ringEdges(anchor.outline) : null;
  if (!outline && !(anchor.radius > SNAP)) return undefined;
  const fringe = stroke / 2;
  const reach = (outline ? Math.max(...anchor.outline.map(p => distance(anchor.p, p))) : anchor.radius) + fringe;
  let nearest, gap = Infinity;
  const consider = (p, entry = p) => {
    const d = distance(anchor.p, entry) + distance(entry, p);
    if (d >= gap) return;
    if (outline ? !inCopper(entry, outline) : d > reach + EPS) return;
    nearest = [anchor.p, entry, p];
    gap = d;
  };
  for (const [a, b] of edges) {
    if (Math.max(a.x, b.x) < anchor.p.x - reach - EPS || Math.min(a.x, b.x) > anchor.p.x + reach + EPS ||
        Math.max(a.y, b.y) < anchor.p.y - reach - EPS || Math.min(a.y, b.y) > anchor.p.y + reach + EPS) continue;
    consider(project(anchor.p, a, b).p);
    if (outline) {
      for (const [c, d] of outline) {
        for (const t of intersections(a, b, c, d)) consider(at(a, b, t));
        if (fringe > 0) {
          const [entry, boundary] = closestSegments(c, d, a, b);
          if (distance(entry, boundary) <= fringe + EPS) consider(boundary, entry);
        }
      }
    }
  }
  return nearest;
}

function computeRoutes(...args) {
  const search = routeSearch(...args);
  let step;
  do { step = search.next(); } while (!step.done);
  return step.value;
}

function* routeSearch(model, start, end, board, maxRoutes = 100) {
  const inside = validateEnds(start, end, board);
  yield '建立走线和过孔连接';
  const graph = new RouteGraph(), warnings = new Set(model.warnings);
  const segments = model.tracks.flatMap(track => track.points.slice(1).map((b, i) => ({
    a: track.points[i], b, layer: track.layer, id: track.id, scale: track.scale || 1,
    radius: Math.max(0, (track.width || 0) / 2 - (track.scale > 1 ? 0.05 : 0)), cuts: [0, 1],
  }))).filter(segment => distance(segment.a, segment.b) > EPS);
  if (segments.length > 7000 || segments.length * model.anchors.length > 4000000) {
    throw new Error('此网络的几何规模超过当前检查上限。未生成路径。');
  }
  const layers = new Map();
  for (const segment of segments) {
    const list = layers.get(segment.layer) || [];
    list.push(segment);
    layers.set(segment.layer, list);
  }
  for (const list of layers.values()) {
    const left = s => Math.min(s.a.x, s.b.x);
    list.sort((a, b) => left(a) - left(b));
    for (let i = 0; i < list.length; i++) {
      const a = list[i], right = Math.max(a.a.x, a.b.x);
      for (let j = i + 1; j < list.length && left(list[j]) <= right + SNAP; j++) {
        const b = list[j];
        if (a.id === b.id) continue;
        if (Math.min(a.a.y, a.b.y) > Math.max(b.a.y, b.b.y) + SNAP ||
          Math.min(b.a.y, b.b.y) > Math.max(a.a.y, a.b.y) + SNAP) continue;
        for (const t of intersections(a.a, a.b, b.a, b.b)) {
          a.cuts.push(t);
          b.cuts.push(project(at(a.a, a.b, t), b.a, b.b).t);
        }
        // Endpoint-to-centerline snaps also cover minor coordinate rounding.
        for (const [line, other] of [[a, b], [b, a]]) {
          for (const endpoint of [line.a, line.b]) {
            const hit = project(endpoint, other.a, other.b);
            if (distance(endpoint, hit.p) <= SNAP && inside(endpoint) && inside(hit.p)) {
              other.cuts.push(hit.t);
              graph.connect(graph.node(endpoint, line.layer), graph.node(hit.p, line.layer),
                distance(endpoint, hit.p), 'track', [endpoint, hit.p], [line.layer]);
            }
          }
        }
      }
    }
  }

  const terminals = [start, end].map(terminal => {
    if (!terminal.track) return terminal;
    const candidates = segments.filter(segment => segment.id === terminal.id && segment.layer === terminal.layers[0]);
    if (!candidates.length) throw new Error('当前 PCB 上找不到选中的导线，请重新选点。');
    const best = candidates.map(segment => ({ segment, ...project(terminal.p, segment.a, segment.b) }))
      .reduce((a, b) => distance(terminal.p, a.p) <= distance(terminal.p, b.p) ? a : b);
    if (!inside(best.p)) throw new Error('走线选点不在原闭合板框内，请重新选点。');
    best.segment.cuts.push(best.t);
    return { ...terminal, p: best.p };
  });

  const padsByLayer = new Map();
  for (const anchor of model.anchors) {
    if (!inside(anchor.p)) continue;
    const depth = model.depthsMm;
    const copper = depth && anchor.layers.length > 1 ?
      anchor.layers.slice().sort((a, b) => depth[a] - depth[b]) : anchor.layers;
    const nodeIds = copper.map(layer => graph.node(anchor.p, layer));
    for (let i = 1; i < nodeIds.length; i++) {
      const a = copper[i - 1], b = copper[i];
      const length = depth ? Math.abs(depth[b] - depth[a]) / 0.0254 : 0;
      graph.connect(nodeIds[i - 1], nodeIds[i], length, 'via', [anchor.p], [a, b]);
    }
    for (const layer of anchor.layers) {
      const anchorId = graph.node(anchor.p, layer);
      if (anchor.radius > SNAP) {
        const pads = padsByLayer.get(layer) || [];
        pads.push(anchor);
        padsByLayer.set(layer, pads);
      }
      for (const segment of layers.get(layer) || []) {
        const hit = project(anchor.p, segment.a, segment.b);
        const reach = Math.max(anchor.radius, SNAP);
        if (distance(anchor.p, hit.p) > reach || !segmentIn(anchor.p, hit.p, board.edges, inside)) continue;
        // Prefer a real endpoint inside the pad, avoiding artificial parallel branches within a pad.
        const ends = [segment.a, segment.b].filter(p => distance(anchor.p, p) <= reach);
        const p = ends.length ? ends.reduce((a, b) => distance(anchor.p, a) <= distance(anchor.p, b) ? a : b) : hit.p;
        if (!segmentIn(anchor.p, p, board.edges, inside)) continue;
        segment.cuts.push(project(p, segment.a, segment.b).t);
        graph.connect(anchorId, graph.node(p, layer), distance(anchor.p, p), 'pad', [anchor.p, p], [layer]);
      }
    }
  }

  for (const [layer, pads] of padsByLayer) {
    const left = pad => pad.p.x - pad.radius;
    pads.sort((a, b) => left(a) - left(b));
    for (let i = 0; i < pads.length; i++) {
      const a = pads[i], right = a.p.x + a.radius;
      for (let j = i + 1; j < pads.length && left(pads[j]) < right; j++) {
        const b = pads[j], length = distance(a.p, b.p);
        if (length >= a.radius + b.radius - SNAP || !segmentIn(a.p, b.p, board.edges, inside)) continue;
        graph.connect(graph.node(a.p, layer), graph.node(b.p, layer), length, 'pad', [a.p, b.p], [layer]);
      }
    }
  }

  const planeJobs = [], meshPlanes = new Map();
  let incomplete = false;
  for (const plane of model.planes) {
    yield '连接铜区与焊盘、过孔';
    const edges = plane.rings.flatMap(ringEdges), ports = new Map(), terminalPorts = new Map();
    if (edges.length > 32000) {
      incomplete = true;
      warnings.add('部分覆铜轮廓超过求解容量，结果可能不完整。');
      continue;
    }
    const box = boundsOf(edges);
    const contains = copperContains(edges, box);
    const addPort = (p, terminal = -1) => {
      if (!inside(p)) return;
      const id = graph.node(p, plane.layer);
      ports.set(id, p);
      if (terminal >= 0) terminalPorts.set(terminal, { id, p });
    };
    const connectAnchor = (anchor, terminal = -1) => {
      const path = copperContact(anchor, edges, plane.stroke);
      if (!path || !segmentIn(path[0], path[1], board.edges, inside) ||
          !segmentIn(path[1], path[2], board.edges, inside)) return;
      const contact = path.at(-1);
      addPort(contact, terminal);
      graph.connect(graph.node(anchor.p, plane.layer), graph.node(contact, plane.layer),
        distance(path[0], path[1]) + distance(path[1], path[2]), 'pad', path, [plane.layer]);
    };
    for (const [i, terminal] of terminals.entries()) {
      if (!terminal.layers.includes(plane.layer) || !inside(terminal.p)) continue;
      if (contains(terminal.p)) {
        addPort(terminal.p, i);
      } else if (!terminal.track) {
        connectAnchor(terminal, i);
      }
    }
    // Keep the exact straight path when both terminals can see each other inside the copper.
    if (terminalPorts.size === 2) {
      const a = terminalPorts.get(0), b = terminalPorts.get(1);
      if (segmentIn(a.p, b.p, edges.concat(board.edges), p => inside(p) && contains(p))) {
        graph.connect(a.id, b.id, distance(a.p, b.p), 'plane', [a.p, b.p], [plane.layer], plane.id);
      }
    }
    const layerSegments = layers.get(plane.layer) || [];
    for (const [index, segment] of layerSegments.entries()) {
      if (index > 0 && index % 64 === 0) yield '连接铜区与焊盘、过孔';
      const reach = segment.radius + (plane.stroke || 0) / 2;
      const { a, b } = segment;
      if (Math.max(a.x, b.x) + reach < box.left || Math.min(a.x, b.x) - reach > box.right ||
          Math.max(a.y, b.y) + reach < box.bottom || Math.min(a.y, b.y) - reach > box.top) continue;
      const values = cuts(segment.a, segment.b, edges);
      let crossing = false;
      for (let i = 1; i < values.length; i++) {
        if (!contains(at(segment.a, segment.b, (values[i - 1] + values[i]) / 2))) continue;
        crossing = true;
        for (const t of [values[i - 1], values[i]]) {
          addPort(at(segment.a, segment.b, t));
          segment.cuts.push(t);
        }
      }
      for (const t of segment.cuts) {
        const p = at(segment.a, segment.b, t);
        if (contains(p)) addPort(p);
      }
      if (!crossing && reach > EPS) {
        const bridge = trackCopperContact(segment, edges, reach);
        if (bridge && segmentIn(...bridge, board.edges, inside)) {
          const [center, boundary] = bridge;
          segment.cuts.push(project(center, a, b).t);
          addPort(boundary);
          graph.connect(graph.node(center, plane.layer), graph.node(boundary, plane.layer),
            distance(center, boundary), 'track', bridge, [plane.layer]);
        }
      }
    }
    const eligibleAnchors = model.anchors.filter(anchor => anchor.layers.includes(plane.layer) &&
      !terminals.some(terminal => terminal.id === anchor.id && !terminal.track));
    for (const [index, anchor] of eligibleAnchors.entries()) {
      if (index > 0 && index % 64 === 0) yield '连接铜区与焊盘、过孔';
      const reach = (anchor.outline ? Math.max(...anchor.outline.map(p => distance(anchor.p, p))) :
        anchor.radius || 0) + (plane.stroke || 0) / 2;
      if (anchor.p.x + reach < box.left || anchor.p.x - reach > box.right ||
          anchor.p.y + reach < box.bottom || anchor.p.y - reach > box.top) continue;
      if (!inside(anchor.p)) continue;
      if (contains(anchor.p)) {
        addPort(anchor.p);
      } else {
        connectAnchor(anchor);
      }
    }
    planeJobs.push({ plane, ports, edges, box, contains });
  }

  // Link separate poured regions only where their actual filled geometry meets.
  let boundaryChecks = 0;
  for (let i = 0; i < planeJobs.length; i++) {
    yield '检查同层铜区交界';
    for (let j = i + 1; j < planeJobs.length; j++) {
      const a = planeJobs[i], b = planeJobs[j];
      if (a.plane.layer !== b.plane.layer || !overlaps(a.box, b.box)) continue;
      const layer = a.plane.layer;
      const addShared = p => {
        if (!inside(p)) return;
        const id = graph.node(p, layer);
        a.ports.set(id, p);
        b.ports.set(id, p);
      };
      for (const p of [...a.ports.values()]) if (b.contains(p)) addShared(p);
      for (const p of [...b.ports.values()]) if (a.contains(p)) addShared(p);
      const incoming = b.edges.slice().sort((p, q) => minX(p) - minX(q));
      let next = 0, active = [];
      for (const edge of a.edges.slice().sort((p, q) => minX(p) - minX(q))) {
        const left = minX(edge), right = maxX(edge);
        active = active.filter(other => maxX(other) >= left - EPS);
        while (next < incoming.length && minX(incoming[next]) <= right + EPS) active.push(incoming[next++]);
        boundaryChecks += active.length;
        if (boundaryChecks > 2000000) {
          incomplete = true;
          warnings.add('覆铜区域交界过于复杂，接触检查未完成。');
          break;
        }
        for (const other of active) {
          if (minX(other) > right + EPS || maxX(other) < left - EPS ||
              minY(other) > maxY(edge) + EPS || maxY(other) < minY(edge) - EPS) continue;
          for (const t of intersections(...edge, ...other)) addShared(at(...edge, t));
        }
      }
    }
  }

  for (const segment of segments) {
    const ts = uniqueSorted(segment.cuts);
    for (let i = 1; i < ts.length; i++) {
      const a = at(segment.a, segment.b, ts[i - 1]), b = at(segment.a, segment.b, ts[i]);
      if (!segmentIn(a, b, board.edges, inside)) continue;
      graph.connect(graph.node(a, segment.layer), graph.node(b, segment.layer),
        distance(a, b) * segment.scale, 'track', [a, b], [segment.layer], '', segment.radius);
    }
  }
  for (const { plane, ports, edges, contains } of planeJobs) {
    yield '搜索覆铜绕行路线';
    if (ports.size < 2) continue;
    if (edges.length + ports.size <= 110 && ports.size <= 36 && routeWithinPlane(graph, plane, board, inside, ports)) continue;
    if (yield* copperMesh(graph, plane, edges, board, inside, ports)) {
      meshPlanes.set(plane.id, { contains, boundary: edges.concat(board.edges) });
    } else {
      incomplete = true;
      warnings.add('部分覆铜分区超过求解容量，结果可能不完整。');
    }
  }

  const ids = terminals.map((terminal, i) => {
    const root = graph.node(terminal.p, 'endpoint-' + i);
    for (const layer of terminal.layers) {
      graph.connect(root, graph.node(terminal.p, layer), 0, 'endpoint', [terminal.p], [layer]);
    }
    return root;
  });
  const seen = new Set();
  const refinementBudget = { remaining: COPPER_REFINEMENT_BUDGET };
  const finish = meshPlanes.size ? edges => {
    const route = mergeMeshRoute(edges, meshPlanes, inside, refinementBudget);
    if (!route) return null;
    const key = route.edges.map(edge => edge.kind + ':' + edge.layers.join(',') + ':' +
      edge.path.map(p => keyOf(p, '')).join(';')).join('|');
    if (seen.has(key)) return null;
    seen.add(key);
    return route;
  } : undefined;
  yield '枚举并排序候选路径';
  const result = yield* enumerateRoutes(graph, ids[0], ids[1], maxRoutes, finish);
  result.routes.sort((a, b) => a.length - b.length);
  if (refinementBudget.exhausted) warnings.add('部分复杂铜区候选达到倒角优化上限，保留已验证的路径。');
  return { ...result, incomplete, warnings: [...warnings] };
}

const SIMILAR_PATH_DISTANCE = 4; // mil
const SIMILAR_PATH_SAMPLES = 128;

function describeRouteShape(route) {
  const sections = [], segments = [], byLayer = new Map();
  let length = 0;
  for (const edge of route.edges) {
    const layer = edge.layers[0];
    if (edge.kind === 'via') {
      sections.push(keyOf(edge.path[0], edge.layers.join('>')));
      continue;
    }
    if (sections.at(-1) !== layer) sections.push(layer);
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    for (let i = 1; i < edge.path.length; i++) {
      const a = edge.path[i - 1], b = edge.path[i], span = distance(a, b);
      if (span <= EPS) continue;
      const segment = { a, b, span, layer };
      length += span;
      segments.push(segment);
      byLayer.get(layer).push(segment);
    }
  }
  const samples = [];
  for (let i = 0, j = 0, passed = 0; i < SIMILAR_PATH_SAMPLES && length > 0; i++) {
    const offset = length * (i + 0.5) / SIMILAR_PATH_SAMPLES;
    while (j + 1 < segments.length && offset > passed + segments[j].span) passed += segments[j++].span;
    const { a, b, span, layer } = segments[j];
    samples.push({ layer, p: at(a, b, (offset - passed) / span) });
  }
  const nearbyByLayer = new Map();
  for (const [layer, items] of byLayer) {
    if (!items.length) continue;
    const bounds = boundsOf(items.map(item => [item.a, item.b]));
    const axis = bounds.right - bounds.left >= bounds.top - bounds.bottom ? 'x' : 'y';
    const low = axis === 'x' ? bounds.left : bounds.bottom;
    const high = axis === 'x' ? bounds.right : bounds.top;
    const size = Math.max(2 * SIMILAR_PATH_DISTANCE, (high - low) / 32);
    const bucket = value => Math.floor((value - low) / size);
    const bins = new Map();
    for (const item of items) {
      const padding = SIMILAR_PATH_DISTANCE * 2;
      const from = bucket(Math.min(item.a[axis], item.b[axis]) - padding);
      const to = bucket(Math.max(item.a[axis], item.b[axis]) + padding);
      for (let i = from; i <= to; i++) {
        if (!bins.has(i)) bins.set(i, []);
        bins.get(i).push(item);
      }
    }
    nearbyByLayer.set(layer, p => bins.get(bucket(p[axis])) || []);
  }
  return { key: JSON.stringify(sections), length, samples, nearbyByLayer };
}

function shortestPerSimilarPath(sortedRoutes) {
  if (sortedRoutes.length < 2) return sortedRoutes;
  const seen = new Map();
  const covers = (source, target, tolerance) => {
    let missed = 0;
    for (const { p, layer } of source.samples) {
      const nearby = target.nearbyByLayer.get(layer)?.(p) || [];
      let gap = Infinity;
      for (const { a, b } of nearby) {
        gap = Math.min(gap, distance(project(p, a, b).p, p));
        if (gap <= tolerance) break;
      }
      if (gap > 2 * tolerance || (gap > tolerance && ++missed > Math.floor(source.samples.length * 0.05))) return false;
    }
    return true;
  };
  return sortedRoutes.filter(route => {
    const shape = describeRouteShape(route);
    if (!shape.length) return true;
    if (!seen.has(shape.key)) seen.set(shape.key, []);
    const candidates = seen.get(shape.key);
    if (candidates.some(shorter => {
      const tolerance = Math.min(SIMILAR_PATH_DISTANCE, shorter.length * 0.02, shape.length * 0.02);
      return covers(shape, shorter, tolerance) && covers(shorter, shape, tolerance);
    })) return false;
    candidates.push(shape);
    return true;
  });
}
