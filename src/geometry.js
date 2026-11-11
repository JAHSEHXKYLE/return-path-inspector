const EPS = 1e-7;
const SNAP = 0.02; // mil
const VIA_CLUSTER_MM = 0.5;
const VIA_DISTANCE_TOLERANCE = 0.025 / 0.0254;
const ROUTE_SIMILARITY_MIL = 4;
const SEARCH_STEP_BUDGET = 500000;
const SIMILARITY_WORK_BUDGET = 2000000;
const MAZE_STATE_LIMIT = 32000;
const START_PROBE_LIMIT = 32;
const START_PROBE_TOTAL_STEPS = 24000;
const BRANCH_PROBE_LIMIT = 48;
const BRANCH_PROBE_STEPS = 4096;
const BRANCH_PROBE_TOTAL_STEPS = 65000;
const SEARCH_TIME_MS = 2500;
const VIA_CLUSTER_WORK_LIMIT = 2000000;
const GRAPH_NODE_LIMIT = 120000;
const GRAPH_EDGE_LIMIT = 240000;
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
  static precedes(a, b) {
    return a.rank < b.rank || (a.rank === b.rank && a.tie < b.tie);
  }
  push(value, rank, tie = 0) {
    const list = this.items, entry = { value, rank, tie };
    let i = list.length;
    list.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!MinHeap.precedes(entry, list[parent])) break;
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
        if (child + 1 < list.length && MinHeap.precedes(list[child + 1], list[child])) child++;
        if (!MinHeap.precedes(list[child], last)) break;
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
    if (this.nodes.length >= GRAPH_NODE_LIMIT) throw new Error('同网连接图达到节点容量上限，已停止建模。');
    return this.nodes.push({ p, layer, edges: [] }) - 1;
  }
  connect(a, b, length, kind, path, layers, plane = '', radius = 0, portal) {
    if (a === b) return;
    const key = [Math.min(a, b), Math.max(a, b), kind, plane].join('|');
    if (this.edgeKeys.has(key)) return;
    if (this.edgeKeys.size >= GRAPH_EDGE_LIMIT) throw new Error('同网连接图达到连线容量上限，已停止建模。');
    this.edgeKeys.add(key);
    const id = this.edgeKeys.size * 2;
    this.nodes[a].edges.push({ id, to: b, length, kind, path, layers, plane, radius, portal });
    this.nodes[b].edges.push({ id: id + 1, to: a, length, kind, path: path.slice().reverse(),
      layers: layers.slice().reverse(), plane, radius, portal: portal?.slice().reverse() });
  }
}

function localCopperDistance(a, b, region, inside, maxDistance, reserve) {
  const boundary = region.boundary;
  const contains = p => inside(p) && region.contains(p);
  if (!reserve(boundary.length)) return Infinity;
  if (segmentIn(a, b, boundary, contains)) return distance(a, b);

  // An admissible short detour can only bend at vertices inside this ellipse.
  const points = [a, b];
  const keys = new Set(points.map(p => keyOf(p, '')));
  if (!reserve(boundary.length)) return Infinity;
  for (const edge of boundary) {
    for (const p of edge) {
      if (distance(a, p) + distance(p, b) > maxDistance + EPS || !contains(p)) continue;
      const key = keyOf(p, '');
      if (keys.has(key)) continue;
      if (points.length >= 32) return Infinity;
      keys.add(key);
      points.push(p);
    }
  }
  const lengths = new Float64Array(points.length).fill(Infinity);
  const closed = new Uint8Array(points.length);
  lengths[0] = 0;
  while (true) {
    let from = -1, best = Infinity;
    for (let i = 0; i < lengths.length; i++) {
      if (!closed[i] && lengths[i] < best) {
        from = i;
        best = lengths[i];
      }
    }
    if (from < 0 || from === 1) return best;
    closed[from] = 1;
    for (let to = 1; to < points.length; to++) {
      if (closed[to]) continue;
      const next = best + distance(points[from], points[to]);
      if (next >= lengths[to] || next + distance(points[to], b) > maxDistance + EPS) continue;
      if (!reserve(boundary.length)) return Infinity;
      if (segmentIn(points[from], points[to], boundary, contains)) lengths[to] = next;
    }
  }
}

function* suppressNearbyVias(graph, anchors, terminals, meshPlanes, board, inside) {
  const suppressed = new Set();
  if (!meshPlanes.size) return { suppressed, count: 0 };
  const viaCount = anchors.filter(anchor => anchor.via).length;
  if (viaCount < 2) return { suppressed, count: 0 };
  yield '检查同铜区相邻过孔';
  const { nodes, keys } = graph;
  const protectedCenters = new Set([...terminals, ...anchors.filter(anchor => !anchor.via)]
    .map(anchor => keyOf(anchor.p, '')));
  const viaCenters = new Set();
  for (const anchor of anchors) {
    if (!anchor.via) continue;
    const key = keyOf(anchor.p, '');
    if (viaCenters.has(key)) protectedCenters.add(key);
    viaCenters.add(key);
  }
  const parent = Int32Array.from(nodes, (_, id) => id);
  const root = id => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]];
      id = parent[id];
    }
    return id;
  };
  for (let id = 0; id < nodes.length; id++) {
    if (id % 512 === 0) yield '检查同铜区相邻过孔';
    for (const edge of nodes[id].edges) {
      if (id < edge.to && edge.kind === 'mesh') parent[root(edge.to)] = root(id);
    }
  }
  const candidates = [];
  for (const [index, anchor] of anchors.entries()) {
    if (index % 128 === 0) yield '检查同铜区相邻过孔';
    if (!anchor.via || protectedCenters.has(keyOf(anchor.p, '')) ||
        terminals.some(terminal => distance(terminal.p, anchor.p) <= SNAP)) continue;
    const barrel = [], contacts = [];
    for (const layer of anchor.layers) {
      const id = keys.get(keyOf(anchor.p, layer));
      if (id == null) continue;
      const edges = nodes[id].edges;
      for (const edge of edges) if (edge.kind === 'via') barrel.push(edge.id);
      if (!edges.some(edge => edge.kind !== 'via')) continue;
      const planes = new Set(edges.filter(edge => edge.kind === 'mesh').map(edge => edge.plane));
      contacts.push({ layer, component: root(id), planes });
    }
    // A transition is interchangeable only if each of its usable copper
    // layers has a shared local pour. Ignore unused inner barrel layers.
    if (contacts.length < 2 || contacts.some(contact => !contact.planes.size)) continue;
    contacts.sort((a, b) => a.layer - b.layer);
    const from = distance(anchor.p, terminals[0].p);
    candidates.push({ p: anchor.p, barrel, contacts, from,
      score: from + distance(anchor.p, terminals[1].p),
      signature: contacts.map(({ layer, component }) => layer + ':' + component).join('|') });
  }
  candidates.sort((a, b) => a.score - b.score || a.from - b.from);
  const reach = VIA_CLUSTER_MM / 0.0254;
  const cells = new Map();
  let checks = 0, count = 0, work = 0;
  const reserve = steps => (work += steps) <= VIA_CLUSTER_WORK_LIMIT;
  candidateLoop: for (const candidate of candidates) {
    const { p, signature } = candidate;
    const x = Math.floor(p.x / reach), y = Math.floor(p.y / reach);
    const cellKey = (a, b) => signature + ':' + a + ':' + b;
    let matched = false;
    for (let dx = -1; dx <= 1 && !matched; dx++) {
      for (let dy = -1; dy <= 1 && !matched; dy++) {
        for (const keep of cells.get(cellKey(x + dx, y + dy)) || []) {
          if (++checks % 128 === 0) yield '检查同铜区相邻过孔';
          if (!reserve(1)) break candidateLoop;
          const gap = distance(p, keep.p);
          if (gap > reach) continue;
          if (!reserve(board.edges.length)) break candidateLoop;
          if (!segmentIn(p, keep.p, board.edges, inside)) continue;
          let shortest = Infinity, longest = 0;
          for (const [i, { planes }] of candidate.contacts.entries()) {
            let length = Infinity;
            for (const id of planes) {
              if (!keep.contacts[i].planes.has(id)) continue;
              const region = meshPlanes.get(id);
              length = Math.min(length, localCopperDistance(p, keep.p, region, inside, gap * 1.5, reserve));
              if (length <= gap + EPS) break;
            }
            shortest = Math.min(shortest, length);
            longest = Math.max(longest, length);
            if (!Number.isFinite(length) || longest - shortest > VIA_DISTANCE_TOLERANCE) break;
          }
          matched = Number.isFinite(longest) && longest - shortest <= VIA_DISTANCE_TOLERANCE;
          if (matched) break;
        }
      }
    }
    if (matched) {
      for (const id of candidate.barrel) suppressed.add(id);
      count++;
    } else {
      const key = cellKey(x, y);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(candidate);
    }
  }
  return { suppressed, count, limited: work > VIA_CLUSTER_WORK_LIMIT };
}

function routeShape(edges) {
  const runs = [];
  let run, length = 0;
  for (const edge of edges) {
    if (edge.kind === 'via') {
      run = undefined;
      continue;
    }
    for (let i = 1; i < edge.path.length; i++) {
      const a = edge.path[i - 1], b = edge.path[i], span = distance(a, b);
      if (span <= EPS) continue;
      const layer = edge.layers[0];
      if (run?.layer !== layer) {
        run = { layer, spans: [], length: 0 };
        runs.push(run);
      }
      const previous = run.spans.at(-1);
      if (previous && previous.plane === edge.plane && distance(previous.b, a) <= EPS &&
          Math.abs(cross(a.x - previous.a.x, a.y - previous.a.y, b.x - a.x, b.y - a.y)) <= EPS &&
          (a.x - previous.a.x) * (b.x - a.x) + (a.y - previous.a.y) * (b.y - a.y) > 0) {
        previous.b = b;
        previous.end += span;
      } else {
        run.spans.push({ a, b, start: run.length, end: run.length + span, plane: edge.plane });
      }
      run.length += span;
      length += span;
    }
  }
  return { length, runs };
}

function inTriangle(p, a, b, c) {
  const turn = (u, v) => cross(v.x - u.x, v.y - u.y, p.x - u.x, p.y - u.y);
  const ab = turn(a, b), bc = turn(b, c), ca = turn(c, a);
  return (ab > EPS && bc > EPS && ca > EPS) || (ab < -EPS && bc < -EPS && ca < -EPS);
}

function sameRouteStrip(p, q, nextP, nextQ, planes, context) {
  const { board, inside, meshPlanes, reserve } = context;
  const perimeter = [[p, q], [q, nextQ], [nextQ, nextP], [nextP, p]];
  const box = boundsOf(perimeter);
  const inStrip = v => inTriangle(v, p, q, nextQ) || inTriangle(v, p, nextQ, nextP);
  const nearStrip = edge => minX(edge) <= box.right + EPS && maxX(edge) >= box.left - EPS &&
    minY(edge) <= box.top + EPS && maxY(edge) >= box.bottom - EPS;
  const boardEdges = board.edges.filter(nearStrip);
  if (boardEdges.length && (!reserve(boardEdges.length) ||
      !segmentIn(p, q, boardEdges, inside) || !segmentIn(nextP, nextQ, boardEdges, inside) ||
      boardEdges.some(edge => edge.some(inStrip)))) return false;

  const regions = [...new Set(planes)].map(id => meshPlanes.get(id)).filter(Boolean);
  if (!regions.length) return true;
  const boundaries = regions.flatMap(region => region.copperEdges.filter(nearStrip));
  if (!boundaries.length) return true;
  const contains = v => regions.some(region => region.contains(v));
  if (!reserve(boundaries.length) || !perimeter.every(([a, b]) => segmentIn(a, b, boundaries, contains))) return false;
  for (const [a, b, c] of [[p, q, nextQ], [p, nextQ, nextP]]) {
    if (Math.abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)) > EPS &&
        !contains(point((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3))) return false;
  }

  // Copper boundaries within the strip are harmless where another fill covers
  // them. An exposed edge inside the strip separates two physical passages.
  for (const [a, b] of boundaries) {
    const length = distance(a, b);
    if (length <= EPS) continue;
    if (!reserve(boundaries.length)) return false;
    const breaks = cuts(a, b, perimeter.concat(boundaries));
    for (let i = 1; i < breaks.length; i++) {
      const mid = at(a, b, (breaks[i - 1] + breaks[i]) / 2);
      if (!inStrip(mid)) continue;
      const dx = (b.y - a.y) * 1e-4 / length, dy = (a.x - b.x) * 1e-4 / length;
      if (!contains(point(mid.x + dx, mid.y + dy)) || !contains(point(mid.x - dx, mid.y - dy))) return false;
    }
  }
  return true;
}

function similarRouteShapes(a, b, context) {
  if (!a.length || !b.length || a.runs.length !== b.runs.length || !context.reserve(1)) return false;
  const tolerance = Math.min(ROUTE_SIMILARITY_MIL, a.length * 0.02, b.length * 0.02);
  const position = (span, offset) => at(span.a, span.b, clamp((offset - span.start) / (span.end - span.start)));
  const strips = [];
  for (const [index, run] of a.runs.entries()) {
    const other = b.runs[index];
    if (run.layer !== other.layer) return false;
    let start = 0;
    for (let i = 0, j = 0; i < run.spans.length && j < other.spans.length;) {
      const first = run.spans[i], second = other.spans[j];
      const endA = first.end / run.length, endB = second.end / other.length;
      const end = Math.min(endA, endB);
      const p = position(first, start * run.length), q = position(second, start * other.length);
      const nextP = position(first, end * run.length), nextQ = position(second, end * other.length);
      const firstGap = distance(p, q), nextGap = distance(nextP, nextQ);
      if (firstGap > tolerance || nextGap > tolerance) return false;
      if (firstGap > EPS || nextGap > EPS) strips.push([p, q, nextP, nextQ, [first.plane, second.plane]]);
      start = end;
      if (endA <= endB) i++;
      if (endB <= endA) j++;
    }
  }
  return strips.every(args => sameRouteStrip(...args, context));
}

function* compressRouteGraph(graph, start, end, suppressed, materialize, similarity) {
  const { nodes } = graph;
  const endpointVias = [start, end].filter(id => nodes[id].edges.length > 1).map(id => nodes[id].p);
  const links = nodes.map(node => node.edges.filter(edge =>
    edge.kind !== 'via' || (!suppressed.has(edge.id) && !endpointVias.some(p => distance(p, edge.path[0]) <= SNAP))));
  const degree = Int32Array.from(links, edges => edges.length);
  const leaves = [];
  for (let id = 0; id < degree.length; id++) {
    if (id !== start && id !== end && degree[id] === 1) leaves.push(id);
  }
  for (let i = 0; i < leaves.length; i++) {
    if (i % 512 === 0) yield '压缩同网连接图';
    const id = leaves[i];
    degree[id] = 0;
    for (const { to } of links[id]) {
      if (degree[to] && --degree[to] === 1 && to !== start && to !== end) leaves.push(to);
    }
  }

  const junctions = nodes.map(() => []);
  const terminals = new Set([...links[start], ...links[end]].map(edge => edge.to));
  for (let id = 0; id < nodes.length; id++) {
    if (id % 512 === 0) yield '压缩同网连接图';
    if (!degree[id] || (degree[id] === 2 && !terminals.has(id) && id !== start && id !== end)) continue;
    for (const first of links[id]) {
      if (!degree[first.to]) continue;
      let last = first, length = first.length;
      const edges = [first];
      while (last.to !== start && last.to !== end && !terminals.has(last.to) && degree[last.to] === 2) {
        const next = links[last.to].find(edge => degree[edge.to] && edge.id !== (last.id ^ 1));
        edges.push(next);
        length += next.length;
        last = next;
      }
      if (last.to !== id) junctions[id].push({ to: last.to, edges, length,
        hasVia: edges.some(edge => edge.kind === 'via') });
    }
  }
  const discarded = new Set();
  for (const [id, outgoing] of junctions.entries()) {
    if (id % 512 === 0) yield '合并相近的并行支路';
    const parallel = new Map();
    for (const link of outgoing) {
      if (link.to <= id || link.edges.some(edge => edge.kind === 'via' || edge.kind === 'endpoint')) continue;
      if (!parallel.has(link.to)) parallel.set(link.to, []);
      parallel.get(link.to).push(link);
    }
    for (const alternatives of parallel.values()) {
      if (alternatives.length < 2) continue;
      const representatives = [];
      const candidates = alternatives.map(link => ({ link, route: materialize(link.edges) }))
        .filter(item => item.route).sort((a, b) => a.route.length - b.route.length);
      for (const { link, route } of candidates) {
        const shape = routeShape(route.edges);
        if (representatives.some(item => similarRouteShapes(shape, item, similarity))) {
          discarded.add(link.edges[0].id);
          discarded.add(link.edges.at(-1).id ^ 1);
        } else representatives.push(shape);
      }
    }
  }
  if (discarded.size) {
    for (const [id, edges] of junctions.entries()) {
      junctions[id] = edges.filter(link => !discarded.has(link.edges[0].id));
    }
  }
  return { links: junctions, collapsedBranches: discarded.size / 2 };
}

function* distancesToTarget(links, end, allowed, stage) {
  const remaining = new Float64Array(links.length).fill(Infinity);
  const queue = new MinHeap();
  remaining[end] = 0;
  queue.push(end, 0);
  let work = 0;
  while (queue.size) {
    if (++work % 512 === 0) yield { stage, detail: '估算到目标的距离' };
    const { value: id, rank } = queue.pop();
    if (rank > remaining[id]) continue;
    for (const edge of links[id]) {
      if (!allowed(edge)) continue;
      const length = rank + edge.length;
      if (length >= remaining[edge.to]) continue;
      remaining[edge.to] = length;
      queue.push(edge.to, length);
    }
  }
  return remaining;
}

function routeTopology(edges, shape) {
  const changes = edges.filter(edge => edge.kind === 'via')
    .map(edge => keyOf(edge.path[0], edge.layers.join('>')));
  return shape.runs.map(run => run.layer).join(',') + '|' + changes.join('|');
}

function* enumerateRoutes(graph, start, end, finishRoute, materialize, suppressed, board, inside, meshPlanes, trace) {
  let similarityWork = 0;
  const similarity = { board, inside, meshPlanes,
    reserve: steps => (similarityWork += Math.max(1, steps)) <= SIMILARITY_WORK_BUDGET };
  const { links, collapsedBranches } =
    yield* compressRouteGraph(graph, start, end, suppressed, materialize, similarity);
  const compressionSimilarityWork = similarityWork;
  const groups = new Map(), signatures = new Set();
  let retainedPoints = 0, routeCount = 0, mergedRoutes = 0;

  function keepRoute(chains, orientedEdges, signature) {
    if (signature && signatures.has(signature)) return 'duplicate';
    const route = finishRoute(chains.flatMap(orientedEdges).filter(edge => edge.kind !== 'endpoint'));
    if (!route) return 'invalid';
    const shape = routeShape(route.edges);
    const key = routeTopology(route.edges, shape);
    const alternatives = groups.get(key) || [];
    const replaced = new Set();
    for (const candidate of alternatives) {
      if (!similarRouteShapes(shape, candidate.shape, similarity)) continue;
      if (candidate.route.length <= route.length + EPS) {
        mergedRoutes++;
        return 'duplicate';
      }
      replaced.add(candidate);
    }
    if (similarityWork > SIMILARITY_WORK_BUDGET) return 'similarity-work';
    const points = route.edges.reduce((total, edge) => total + edge.path.length + 1, 0) +
      shape.runs.reduce((total, run) => total + 2 * run.spans.length, 0);
    for (const candidate of replaced) {
      retainedPoints -= candidate.points;
      signatures.delete(candidate.signature);
    }
    if (signature) signatures.add(signature);
    retainedPoints += points;
    const kept = replaced.size ? alternatives.filter(candidate => !replaced.has(candidate)) : alternatives;
    kept.push({ route, shape, points, signature });
    groups.set(key, kept);
    routeCount += 1 - replaced.size;
    mergedRoutes += replaced.size;
    return replaced.size ? 'replaced' : 'added';
  }

  function* pass(from, to, direction, stage) {
    similarityWork = 0;
    yield { stage, detail: '已保留 ' + routeCount + ' 类' };
    const report = data => trace('solver.enumeration', { ...data, direction, routes: routeCount,
      retainedPoints, collapsedBranches, mergedRoutes, transitionSequences: groups.size, similarityWork,
      compressionSimilarityWork });
    return yield* searchRoutes(graph, links, from, to, direction, stage, keepRoute, () => routeCount, report);
  }

  const forward = yield* pass(start, end, 'forward', '正向搜索连通路径');
  let limited = forward.limited;
  if (forward.connected) {
    const reverse = yield* pass(end, start, 'reverse', '从流入点反向搜索');
    limited ||= reverse.limited;
    const endLayers = new Set(links[end].map(link => graph.nodes[link.to].layer));
    if (links[start].some(link => endLayers.has(graph.nodes[link.to].layer))) {
      const sameLayer = yield* pass(start, end, 'same-layer', '搜索不换层路径');
      limited ||= sameLayer.limited;
    } else {
      trace('solver.enumeration', { direction: 'same-layer', connected: false, reason: 'no-shared-layer',
        routes: routeCount, added: 0 });
    }
  }
  const routes = [...groups.values()].flatMap(items => items.map(item => item.route));
  return { routes, limited, collapsedBranches, mergedRoutes };
}

function* searchRoutes(graph, links, start, end, direction, stage, keepRoute, routeCount, report) {
  const allowed = link => direction !== 'same-layer' || !link.hasVia;
  const remaining = yield* distancesToTarget(links, end, allowed, stage);
  if (!Number.isFinite(remaining[start])) {
    report({ connected: false, added: 0 });
    return { connected: false, limited: false };
  }
  for (const [i, edges] of links.entries()) {
    if (i % 512 === 0) yield { stage, detail: '排列优先搜索的支路' };
    edges.sort((a, b) => (a.length + remaining[a.to]) - (b.length + remaining[b.to]));
  }
  const starts = new Set(links[start].map(edge => edge.to));
  const ends = new Set(links[end].map(edge => edge.to));
  const visited = new Uint32Array(links.length);
  const frontier = new MinHeap();
  const startProbes = [], branchProbes = [], scheduledBranches = new Set(), coveredBranches = new Set();
  const startBudget = { runs: 0, solutions: 0, work: 0, limit: START_PROBE_TOTAL_STEPS };
  const branchBudget = { runs: 0, solutions: 0, work: 0, limit: BRANCH_PROBE_TOTAL_STEPS };
  const probedPaths = new Set();
  const blocked = new Uint32Array(links.length);
  const measured = new Uint32Array(links.length);
  const probeCosts = new Float64Array(links.length);
  let work = 0, stateCount = 1, frontierPeak = 1, expanded = 0;
  let nextStartProbe = 0, initialStartProbes = 0, nextProbe = 0, probeStamp = 0, waveSteps = 0;
  let preferStart = true;
  let found = false, added = 0, duplicates = 0, replacements = 0, waveLimited = false, limit = '';
  let deadline = Date.now() + SEARCH_TIME_MS;
  const root = { id: start, cost: 0, depth: 0, previous: null, link: null };
  frontier.push(root, remaining[start]);

  const usable = (id, link) => allowed(link) && Number.isFinite(remaining[link.to]) &&
    (id === start || !starts.has(link.to)) && (!ends.has(id) || link.to === end);
  const branchId = link => link.edges[0].id;
  const reverse = direction === 'reverse';
  // Match the corresponding compressed link in the canonical A-to-B direction.
  const edgeId = reverse ? link => link.edges.at(-1).id ^ 1 : branchId;
  const orientedEdges = reverse ?
    link => links[link.to].find(candidate => branchId(candidate) === edgeId(link)).edges : link => link.edges;
  function* progress() {
    const paused = Date.now();
    yield { stage, detail: '已保留 ' + routeCount() + ' 类' };
    deadline += Date.now() - paused;
  }

  function startDirection(link, origin) {
    for (const edge of link.edges) {
      if (edge.kind === 'via') return edge.layers.join('>');
      for (const p of edge.path) {
        if (distance(origin, p) <= SNAP) continue;
        const angle = Math.atan2(p.y - origin.y, p.x - origin.x);
        return (Math.round(angle / (Math.PI / 4)) + 8) % 8;
      }
    }
    return 'coincident';
  }

  function scheduleStartDirections() {
    const layers = [];
    for (const access of links[start]) {
      if (!usable(start, access)) continue;
      // The first edge selects a copper layer at the endpoint. Probe the
      // actual exit on that layer so a second direction gets its own search.
      const prefix = { id: access.to, cost: access.length, depth: 1, previous: root, link: access };
      const sectors = new Map();
      for (const link of links[prefix.id]) {
        if (link.to === start || !usable(prefix.id, link) || coveredBranches.has(branchId(link))) continue;
        const direction = startDirection(link, graph.nodes[prefix.id].p);
        if (!sectors.has(direction)) sectors.set(direction, []);
        sectors.get(direction).push(link);
      }
      if (sectors.size) layers.push({ prefix, sectors: [...sectors.values()] });
    }
    const sectorCount = layers.reduce((count, layer) => Math.max(count, layer.sectors.length), 0);
    for (let variant = 0; startProbes.length < START_PROBE_LIMIT; variant++) {
      let offered = false;
      for (let sector = 0; sector < sectorCount && startProbes.length < START_PROBE_LIMIT; sector++) {
        for (const { prefix, sectors } of layers) {
          const link = sectors[sector]?.[variant];
          if (!link) continue;
          startProbes.push({ prefix, link });
          scheduledBranches.add(branchId(link));
          offered = true;
          if (startProbes.length === START_PROBE_LIMIT) break;
        }
      }
      if (variant === 0) initialStartProbes = startProbes.length;
      if (!offered) break;
    }
  }

  function scheduleBranches(state) {
    const prefixes = [];
    for (let cursor = state; cursor.previous; cursor = cursor.previous) {
      coveredBranches.add(branchId(cursor.link));
      coveredBranches.add(cursor.link.edges.at(-1).id ^ 1);
      prefixes.push(cursor.previous);
    }
    if (!found) scheduleStartDirections();
    if (branchProbes.length >= BRANCH_PROBE_LIMIT || branchBudget.work >= branchBudget.limit) return;
    const forks = [];
    for (const prefix of prefixes.reverse()) {
      if (prefix.id === start || starts.has(prefix.id)) continue;
      const choices = links[prefix.id].filter(link => usable(prefix.id, link) &&
        !coveredBranches.has(branchId(link)) && !scheduledBranches.has(branchId(link)));
      if (choices.length) forks.push({ prefix, choices });
    }
    // Spread probes along the route before trying several exits at one junction.
    const ordered = forks.length > 1 ? [forks[0], forks.at(-1)] : forks.slice();
    const ranges = [[1, forks.length - 1]];
    for (let i = 0; i < ranges.length && ordered.length < BRANCH_PROBE_LIMIT; i++) {
      const [from, to] = ranges[i];
      if (from >= to) continue;
      const mid = Math.floor((from + to) / 2);
      ordered.push(forks[mid]);
      ranges.push([from, mid], [mid + 1, to]);
    }
    for (let exit = 0; ordered.length && branchProbes.length < BRANCH_PROBE_LIMIT; exit++) {
      let offered = false;
      for (const { prefix, choices } of ordered) {
        const link = choices[exit];
        if (!link) continue;
        offered = true;
        scheduledBranches.add(branchId(link));
        branchProbes.push({ prefix, link });
        if (branchProbes.length === BRANCH_PROBE_LIMIT) break;
      }
      if (!offered) break;
    }
  }

  function* probeBranch({ prefix, link }, budget) {
    if (coveredBranches.has(branchId(link))) return;
    const stamp = ++probeStamp;
    budget.runs++;
    for (let cursor = prefix; cursor; cursor = cursor.previous) blocked[cursor.id] = stamp;
    if (blocked[link.to] === stamp) return;
    const pending = new MinHeap();
    const first = { id: link.to, cost: prefix.cost + link.length, depth: prefix.depth + 1, previous: prefix, link };
    measured[first.id] = stamp;
    probeCosts[first.id] = first.cost;
    pending.push(first, first.cost + remaining[first.id], -first.depth);
    const stopAt = Math.min(budget.work + BRANCH_PROBE_STEPS, budget.limit);
    while (pending.size && budget.work < stopAt && Date.now() < deadline) {
      const { value: state } = pending.pop();
      if (state.cost > probeCosts[state.id]) continue;
      if (state.id === end) return state;
      for (const next of links[state.id]) {
        if (budget.work >= stopAt) return;
        if (++budget.work % 256 === 0) yield* progress();
        if (blocked[next.to] === stamp || !usable(state.id, next)) continue;
        const cost = state.cost + next.length;
        if (measured[next.to] === stamp && probeCosts[next.to] <= cost) continue;
        measured[next.to] = stamp;
        probeCosts[next.to] = cost;
        const depth = state.depth + 1;
        pending.push({ id: next.to, cost, depth, previous: state, link: next }, cost + remaining[next.to], -depth);
      }
    }
  }

  function considerRoute(state, fromProbe = false) {
    const chains = [];
    for (let current = state; current.link; current = current.previous) chains.push(current.link);
    if (!reverse) chains.reverse();
    // Use forward edge IDs for both directions. Reuse the original forward
    // edges so path geometry, via order and copper portals stay consistent.
    const signature = chains.length <= 512 ? chains.map(edgeId).join(',') : '';
    if (signature) {
      if (probedPaths.has(signature)) return false;
      if (fromProbe) probedPaths.add(signature);
    }
    const outcome = keepRoute(chains, orientedEdges, signature);
    switch (outcome) {
      case 'invalid': return false;
      case 'duplicate': duplicates++; break;
      case 'replaced': replacements++; break;
      case 'added': added++; break;
      default: limit = outcome; return false;
    }
    // The first route of a later pass can already be in the list. Its
    // unused exits still need to be explored in this direction.
    if (!found || outcome === 'added') scheduleBranches(state);
    if (!found) waveSteps = 16;
    found = true;
    return outcome === 'added';
  }

  while (!limit) {
    const canProbeStart = nextStartProbe < startProbes.length && startBudget.work < startBudget.limit;
    const canProbeBranch = nextProbe < branchProbes.length && branchBudget.work < branchBudget.limit;
    if (!frontier.size && !canProbeStart && !canProbeBranch) break;
    if (work >= SEARCH_STEP_BUDGET || Date.now() >= deadline) {
      limit = work >= SEARCH_STEP_BUDGET ? 'search-steps' : 'search-time';
      break;
    }
    // Probe an unused exit periodically so longer passages have a chance
    // before the length-ordered wave fills the result budget.
    const firstStartPass = canProbeStart && nextStartProbe < initialStartProbes;
    if ((canProbeStart || canProbeBranch) && (firstStartPass || waveSteps >= 16 || !frontier.size)) {
      const fromStart = canProbeStart && (firstStartPass || !canProbeBranch || preferStart);
      const budget = fromStart ? startBudget : branchBudget;
      const probe = fromStart ? startProbes[nextStartProbe++] : branchProbes[nextProbe++];
      const solution = yield* probeBranch(probe, budget);
      if (solution && considerRoute(solution, true)) budget.solutions++;
      preferStart = !fromStart;
      waveSteps = 0;
      continue;
    }
    if (++expanded % 256 === 0) yield* progress();
    waveSteps++;
    const { value: state } = frontier.pop();
    if (state.id === end) {
      considerRoute(state);
      continue;
    }

    for (let current = state; current; current = current.previous) visited[current.id] = expanded;
    for (const link of links[state.id]) {
      if (++work > SEARCH_STEP_BUDGET) break;
      if (visited[link.to] === expanded || !usable(state.id, link)) continue;
      if (stateCount >= MAZE_STATE_LIMIT) {
        waveLimited = true;
        break;
      }
      const cost = state.cost + link.length;
      const depth = state.depth + 1;
      frontier.push({ id: link.to, cost, depth, previous: state, link }, cost + remaining[link.to], -depth);
      stateCount++;
    }
    frontierPeak = Math.max(frontierPeak, frontier.size);
  }
  if (!limit && waveLimited) limit = 'maze-states';
  report({ algorithm: 'weighted-maze', connected: true, added, duplicates, replacements, steps: work,
    expanded, stateCount, frontierPeak,
    startProbes: startBudget.runs, startSolutions: startBudget.solutions, startProbeSteps: startBudget.work,
    branchProbes: branchBudget.runs, branchSolutions: branchBudget.solutions, probeSteps: branchBudget.work,
    limit: limit || null, budgets: { states: MAZE_STATE_LIMIT, steps: SEARCH_STEP_BUDGET, searchMs: SEARCH_TIME_MS } });
  return { connected: true, limited: Boolean(limit) };
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
  let boundaryWork = 0;
  for (const edge of boardEdges) {
    const limit = boundsOf([edge]);
    for (const [a, b] of copperEdges) {
      if (++boundaryWork % 4096 === 0) yield '搜索覆铜绕行路线';
      if (boundaryWork > 3000000 || breaks.length > 150000) return false;
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
          'mesh', [a.center, gate, b.center], [layer], id, 0, [point(x, high), point(x, low)]);
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

// String-pull through the ordered gates of the chosen cells. The gate order
// keeps paths on their chosen side of a cutout, even if another shortcut exists.
function pathThroughPortals(start, end, portals) {
  const area = (a, b, c) => cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  const path = [start], gates = [[start, start], ...portals, [end, end]];
  let left = 0, right = 0;
  let leftPoint = start, rightPoint = start;
  for (let i = 1; i < gates.length; i++) {
    const apex = path.at(-1), [l, r] = gates[i];
    if (area(apex, rightPoint, r) >= -EPS) {
      if (distance(apex, rightPoint) <= EPS || area(apex, leftPoint, r) < -EPS) {
        right = i;
        rightPoint = r;
      } else {
        path.push(leftPoint);
        i = right = left;
        rightPoint = leftPoint;
        continue;
      }
    }
    if (area(apex, leftPoint, l) <= EPS) {
      if (distance(apex, leftPoint) <= EPS || area(apex, rightPoint, l) > EPS) {
        left = i;
        leftPoint = l;
      } else {
        path.push(rightPoint);
        i = left = right;
        leftPoint = rightPoint;
      }
    }
  }
  if (distance(path.at(-1), end) > EPS) path.push(end);
  return path;
}

function mergeMeshRoute(edges, meshPlanes, inside, budget, cache = { sections: new Map(), points: 0 }) {
  const result = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (edge.kind !== 'mesh') {
      result.push(edge);
      continue;
    }
    const start = i;
    while (edges[i + 1]?.kind === 'mesh' && edges[i + 1].plane === edge.plane) i++;
    const run = edges.slice(start, i + 1);
    const key = edge.id == null || run.length > 512 ? null : run.map(item => item.id).join(',');
    if (key !== null && cache.sections.has(key)) {
      result.push(cache.sections.get(key));
      continue;
    }
    const region = meshPlanes.get(edge.plane);
    const contains = p => inside(p) && region.contains(p);
    const portals = run.flatMap(item => item.portal ? [item.portal] : []);
    let path = pathThroughPortals(edge.path[0], run.at(-1).path.at(-1), portals);
    const legal = points => points.every((p, j) =>
      !j || segmentIn(points[j - 1], p, region.boundary, contains));
    if (!legal(path)) {
      path = [edge.path[0], ...run.flatMap(item => item.path.slice(1))];
      if (!legal(path)) return null;
      refineCopperPath(path, region.boundary, contains, budget);
    }
    const length = path.slice(1).reduce((sum, p, j) => sum + distance(path[j], p), 0);
    const section = { kind: 'plane', layers: edge.layers, plane: edge.plane, path, length };
    const cost = run.length + path.length;
    if (key !== null && cache.points + cost <= 12000) {
      cache.sections.set(key, section);
      cache.points += cost;
    }
    result.push(section);
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
    if (run.length > 1 && density > 0) {
      const rounded = [run[0]];
      for (let i = 1; i < run.length - 1; i++) {
        rounded.push(...roundedPreviewCorner(run[i - 1], run[i], run[i + 1], sources[i - 1], sources[i],
          density * 3, span * 0.04, board, regions));
      }
      rounded.push(run.at(-1));
      paths.push({ layer, points: rounded });
    } else if (run.length > 1) {
      paths.push({ layer, points: run });
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

function copperContacts(anchor, edges, stroke = 0) {
  const outline = anchor.outline ? ringEdges(anchor.outline) : null;
  if (!outline && !(anchor.radius > SNAP)) return [];
  const fringe = stroke / 2;
  const reach = (outline ? Math.max(...anchor.outline.map(p => distance(anchor.p, p))) : anchor.radius) + fringe;
  const contacts = [], vertices = new Map();
  const root = id => {
    while (contacts[id].parent !== id) {
      contacts[id].parent = contacts[contacts[id].parent].parent;
      id = contacts[id].parent;
    }
    return id;
  };
  const covers = p => outline ?
    inCopper(p, outline) || (fringe > 0 && outline.some(([a, b]) => distance(p, project(p, a, b).p) <= fringe + EPS)) :
    distance(anchor.p, p) <= reach + EPS;
  for (const [a, b] of edges) {
    if (Math.max(a.x, b.x) < anchor.p.x - reach - EPS || Math.min(a.x, b.x) > anchor.p.x + reach + EPS ||
        Math.max(a.y, b.y) < anchor.p.y - reach - EPS || Math.min(a.y, b.y) > anchor.p.y + reach + EPS) continue;
    let nearest, gap = Infinity;
    const consider = (p, entry = p) => {
      const d = distance(anchor.p, entry) + distance(entry, p);
      if (d >= gap) return;
      if (outline ? !inCopper(entry, outline) : d > reach + EPS) return;
      nearest = [anchor.p, entry, p];
      gap = d;
    };
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
    if (!nearest) continue;
    const id = contacts.length;
    contacts.push({ parent: id, path: nearest, length: gap });
    // Adjacent boundary pieces inside the pad form one contact. Separate
    // spokes or islands keep their own entry into the copper graph.
    for (const vertex of [a, b]) {
      if (!covers(vertex)) continue;
      const key = keyOf(vertex, '');
      if (vertices.has(key)) contacts[root(id)].parent = root(vertices.get(key));
      else vertices.set(key, id);
    }
  }
  const entries = new Map();
  for (const [id, contact] of contacts.entries()) {
    const group = root(id);
    if (!entries.has(group) || entries.get(group).length > contact.length) entries.set(group, contact);
  }
  return [...entries.values()].map(contact => contact.path);
}

function computeRoutes(model, start, end, board) {
  const search = routeSearch(model, start, end, board);
  let step;
  do { step = search.next(); } while (!step.done);
  return step.value;
}

function* routeSearch(model, start, end, board, trace = () => {}) {
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
      if (i % 64 === 0) yield '建立走线和过孔连接';
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
  for (const [index, anchor] of model.anchors.entries()) {
    if (index % 32 === 0) yield '建立走线和过孔连接';
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
    const edges = plane.rings.flatMap(ringEdges), ports = new Map();
    if (edges.length > 32000) {
      incomplete = true;
      warnings.add('部分覆铜轮廓超过求解容量，结果可能不完整。');
      continue;
    }
    const box = boundsOf(edges);
    const contains = copperContains(edges, box);
    const addPort = p => {
      if (!inside(p)) return;
      const id = graph.node(p, plane.layer);
      ports.set(id, p);
    };
    const connectAnchor = anchor => {
      for (const path of copperContacts(anchor, edges, plane.stroke)) {
        if (!segmentIn(path[0], path[1], board.edges, inside) ||
            !segmentIn(path[1], path[2], board.edges, inside)) continue;
        const contact = path.at(-1);
        addPort(contact);
        graph.connect(graph.node(anchor.p, plane.layer), graph.node(contact, plane.layer),
          distance(path[0], path[1]) + distance(path[1], path[2]), 'pad', path, [plane.layer]);
      }
    };
    for (const terminal of terminals) {
      if (!terminal.layers.includes(plane.layer) || !inside(terminal.p)) continue;
      if (contains(terminal.p)) {
        addPort(terminal.p);
      } else if (!terminal.track) {
        connectAnchor(terminal);
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

  for (const [index, segment] of segments.entries()) {
    if (index % 128 === 0) yield '建立走线和过孔连接';
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
    if (yield* copperMesh(graph, plane, edges, board, inside, ports)) {
      meshPlanes.set(plane.id, { contains, copperEdges: edges, boundary: edges.concat(board.edges) });
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
  for (const [index, terminal] of terminals.entries()) {
    const exits = terminal.layers.flatMap(layer => graph.nodes[graph.node(terminal.p, layer)].edges
      .filter(edge => edge.kind !== 'via' && edge.kind !== 'endpoint')
      .map(edge => ({ layer, kind: edge.kind,
        p: edge.path.find(p => distance(terminal.p, p) > SNAP) || graph.nodes[edge.to].p })));
    trace('solver.endpoint-exits', { role: index ? 'end' : 'start', id: terminal.id, p: terminal.p,
      count: exits.length, exits: exits.slice(0, 32) });
  }
  const refinementBudget = { remaining: COPPER_REFINEMENT_BUDGET };
  const { suppressed, count: mergedVias, limited: mergeLimited } =
    yield* suppressNearbyVias(graph, model.anchors, terminals, meshPlanes, board, inside);
  trace('solver.graph', { nodes: graph.nodes.length, edges: graph.edgeKeys.size, trackSegments: segments.length,
    copperRegions: planeJobs.length, meshedRegions: meshPlanes.size, mergedVias, suppressedViaEdges: suppressed.size / 2,
    mergeRadiusMm: VIA_CLUSTER_MM, mergeDistanceToleranceMm: VIA_DISTANCE_TOLERANCE * 0.0254,
    mergeLimited: Boolean(mergeLimited), incomplete });
  const meshCache = { sections: new Map(), points: 0 };
  const materialize = edges => mergeMeshRoute(edges, meshPlanes, inside, refinementBudget, meshCache);
  const finish = edges => {
    const route = materialize(edges);
    if (!route) {
      incomplete = true;
      warnings.add('部分铜区通道未通过完整几何校验，结果可能不完整。');
    }
    return route;
  };
  yield { stage: '搜索连通路径', detail: '已保留 0 类' };
  const { routes, limited, collapsedBranches, mergedRoutes } =
    yield* enumerateRoutes(graph, ids[0], ids[1], finish, materialize, suppressed, board, inside, meshPlanes, trace);
  yield '按长度排列 ' + routes.length + ' 条路径';
  routes.sort((a, b) => a.length - b.length);
  if (refinementBudget.exhausted) warnings.add('部分复杂铜区候选达到倒角优化上限，保留已验证的路径。');
  if (mergeLimited) warnings.add('达到过孔合并预算，其余过孔仍按独立位置参与搜索。');
  trace('solver.result', { routes: routes.length, shortestMil: routes[0]?.length, longestMil: routes.at(-1)?.length,
    incomplete, limited, meshCachePoints: meshCache.points, warningCount: warnings.size });
  for (const [i, route] of routes.slice(0, 6).entries()) {
    const changes = route.edges.filter(edge => edge.kind === 'via');
    trace('solver.route-sample', { route: i + 1, lengthMil: route.length, edges: route.edges.length,
      viaCount: changes.length, changes: changes.slice(0, 8).map(edge => ({ p: edge.path[0], layers: edge.layers })) });
  }
  return { routes, incomplete, limited, mergedVias, collapsedBranches, mergedRoutes, warnings: [...warnings] };
}
