const BOARD_LAYER = 11;
const MULTI_LAYER = 12;
const copperCoverTypes = ['Copper Region', 'Fill Region', 'Pour', 'Poured', 'Fill'];
const pickable = ['ComponentPad', 'Pad', 'Via', 'Line', 'Arc', 'Track', 'ArcTrack', 'Component', ...copperCoverTypes];
const pointPickTypes = ['Line', 'Arc', 'Track', 'ArcTrack', 'Component', ...copperCoverTypes];
const DEFAULT_CURVE_DENSITY = 2;
const state = (primitive, field) => {
  const getter = primitive?.['getState_' + field];
  return typeof getter === 'function' ? getter.call(primitive) :
    primitive?.[field[0].toLowerCase() + field.slice(1)];
};

function readPolygon(polygon, close = false, scale = 1) {
  const data = polygon?.getSource?.() || (Array.isArray(polygon) ? polygon : null);
  if (!Array.isArray(data) || !data.length) throw new Error('无法读取多边形几何。');
  const read = i => {
    // PCB geometry returned by the desktop API is already in the same coordinates as pads and vias.
    if (!Number.isFinite(data[i]) || !Number.isFinite(data[i + 1])) throw new Error('多边形坐标不完整。');
    return point(data[i] * scale, data[i + 1] * scale);
  };
  if (data[0] === 'R') {
    const a = read(1), [, , , width, height, degrees = 0, rounded = 0] = data;
    const w = width * scale, h = height * scale;
    if (!(w > 0 && h > 0) || !Number.isFinite(degrees) || !Number.isFinite(rounded)) throw new Error('矩形参数无效。');
    const r = Math.max(0, Math.min(rounded * scale, w / 2, h / 2)), angle = degrees * Math.PI / 180;
    const shift = (x, y) => point(a.x + x * Math.cos(angle) - y * Math.sin(angle), a.y + x * Math.sin(angle) + y * Math.cos(angle));
    if (!r) return [a, shift(w, 0), shift(w, -h), shift(0, -h), a];
    const corners = [[w - r, -r, 90], [w - r, -h + r, 0], [r, -h + r, -90], [r, -r, -180]];
    const samples = corners.flatMap(([x, y, start]) => Array.from({ length: 13 }, (_, i) => {
      const t = (start - i * 7.5) * Math.PI / 180;
      return shift(x + r * Math.cos(t), y + r * Math.sin(t));
    }));
    return [...samples, samples[0]];
  }
  if (data[0] === 'CIRCLE') {
    const c = read(1), radius = data[3] * scale;
    if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('圆形半径无效。');
    const count = Math.min(512, Math.max(32, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.05 / radius)))));
    const samples = Array.from({ length: count }, (_, i) => {
      const angle = 2 * Math.PI * i / count;
      return point(c.x + radius * Math.cos(angle), c.y - radius * Math.sin(angle));
    });
    return [...samples, samples[0]];
  }
  const points = [read(0)];
  let mode = 'L';
  for (let i = 2; i < data.length;) {
    if (typeof data[i] === 'string') {
      mode = data[i++];
      if (mode === 'Z' && i === data.length) {
        points.push(points[0]);
        break;
      }
    }
    if (mode === 'L') {
      points.push(read(i));
      i += 2;
    } else if (mode === 'ARC' || mode === 'CARC') {
      if (!Number.isFinite(data[i])) throw new Error('圆弧角度无效。');
      points.push(...arcPoints(points.at(-1), read(i + 1), data[i]).points.slice(1));
      i += 3;
    } else if (mode === 'C') {
      const a = points.at(-1), b = read(i), c = read(i + 2), d = read(i + 4);
      for (let j = 1; j <= 32; j++) {
        const t = j / 32;
        points.push(at(at(at(a, b, t), at(b, c, t), t), at(at(b, c, t), at(c, d, t), t), t));
      }
      i += 6;
    } else {
      throw new Error('多边形命令不支持（' + mode + '）。');
    }
  }
  if (close && distance(points[0], points.at(-1)) > SNAP) points.push(points[0]);
  return points;
}

function readPolygonParts(complexPolygon) {
  const polygons = typeof complexPolygon?.toPolygon === 'function' ?
    complexPolygon.toPolygon() : complexPolygon?.getSource ? [complexPolygon] :
      Array.isArray(complexPolygon) ? (Array.isArray(complexPolygon[0]) ? complexPolygon : [complexPolygon]) : null;
  if (!Array.isArray(polygons) || !polygons.length) throw new Error('无法解析实际铜区边界。');
  return polygons;
}

function readRings(complexPolygon, scale = 1) {
  const rings = readPolygonParts(complexPolygon).map(polygon => cleanRing(readPolygon(polygon, true, scale)));
  if (rings.some(ring => ring.length < 3)) throw new Error('铜区或槽孔含退化轮廓。');
  return rings;
}

function readTrack(primitive, density = DEFAULT_CURVE_DENSITY) {
  const a = point(state(primitive, 'StartX'), state(primitive, 'StartY'));
  const b = point(state(primitive, 'EndX'), state(primitive, 'EndY'));
  const layer = state(primitive, 'Layer'), id = state(primitive, 'PrimitiveId');
  if (!validPoint(a) || !validPoint(b) || !Number.isFinite(layer) || !id) {
    throw new Error('无法读取导线或板框图元的位置。');
  }
  const data = state(primitive, 'PrimitiveType') === 'Arc' ?
    arcPoints(a, b, state(primitive, 'ArcAngle'), layer === BOARD_LAYER ? 1 : density) : { points: [a, b], scale: 1 };
  const width = Number(state(primitive, 'LineWidth')) || 0;
  return { id, layer, width, ...data };
}

class BoardGeometryError extends Error {}

async function readOutlinePolylines(listed) {
  const ids = [...new Set(listed.map(item => state(item, 'PrimitiveId')))];
  if (ids.some(id => !id)) throw new Error('板框折线缺少图元 ID。');
  const outlines = [];
  // EDA 4.1.93 can pair a board-outline ID with the path of a custom-layer polyline in getAll().
  // Read each listed ID back by ID before trusting its geometry.
  for (let offset = 0; offset < ids.length; offset += 64) {
    const batch = ids.slice(offset, offset + 64);
    const items = await eda.pcb_PrimitivePolyline.get(batch);
    const byId = new Map(items.map(item => [state(item, 'PrimitiveId'), item]));
    for (const id of batch) {
      const item = byId.get(id);
      if (!item) throw new Error('无法按图元 ID 读取板框折线 ' + id + '。');
      if (state(item, 'Layer') === BOARD_LAYER) outlines.push(item);
    }
  }
  return outlines;
}

async function readBoard(previewIds = []) {
  const [lines, arcs, polygons, slots] = await Promise.all([
    eda.pcb_PrimitiveLine.getAll(undefined, BOARD_LAYER),
    eda.pcb_PrimitiveArc.getAll(undefined, BOARD_LAYER),
    eda.pcb_PrimitivePolyline.getAll(undefined, BOARD_LAYER),
    eda.pcb_PrimitiveFill.getAll(MULTI_LAYER),
  ]);
  const ignored = new Set(previewIds);
  const onLayer = layer => item => state(item, 'Layer') === layer && !ignored.has(state(item, 'PrimitiveId'));
  const tracks = [...lines, ...arcs].filter(onLayer(BOARD_LAYER));
  const listedOutlines = polygons.filter(onLayer(BOARD_LAYER));
  const holes = slots.filter(onLayer(MULTI_LAYER));
  try {
    const paths = tracks.map(item => readTrack(item).points);
    // A PCB polyline can be open even though the API calls its source a polygon.
    for (const primitive of await readOutlinePolylines(listedOutlines)) {
      paths.push(readPolygon(state(primitive, 'Polygon')));
    }
    const cutouts = holes.flatMap(item => readRings(state(item, 'ComplexPolygon')));
    return sealBoard(paths, cutouts);
  } catch (error) {
    throw new BoardGeometryError(error.message + ' 校验输入为 ' + tracks.length + ' 条直线或圆弧、' +
      listedOutlines.length + ' 条板框折线、' + holes.length + ' 个槽孔图元。', { cause: error });
  }
}

function copperLayers(items) {
  return items.filter(layer => ['SIGNAL', 'PLANE'].includes(layer.type) && Number(layer.layerStatus) !== 0)
    .map(layer => ({ id: Number(layer.id), name: layer.name, color: layer.color, status: Number(layer.layerStatus) }))
    .filter(layer => Number.isFinite(layer.id))
    .sort((a, b) => a.id === 2 ? 1 : b.id === 2 ? -1 : a.id - b.id);
}

function validCopperDepths(depths, layerIds) {
  if (!depths || layerIds.length < 2 || depths[1] !== 0) return false;
  const values = layerIds.map(id => depths[id]);
  return new Set(values).size === layerIds.length &&
    values.every(depth => Number.isFinite(depth) && depth >= 0 && depth <= depths[2]);
}

function stackDepths(configuration, layerIds) {
  if (!Array.isArray(configuration?.list) || configuration.list.some(row => !row || typeof row !== 'object')) return;
  const ids = new Set(layerIds);
  const rows = configuration.list.map(row => ({
    id: row.layerId ?? row.id,
    thickness: row.thicknessMm ?? row.thickness,
    order: row.zIndex,
  }));
  if (rows.every(row => Number.isFinite(row.order))) rows.sort((a, b) => a.order - b.order);
  if (rows.find(row => ids.has(row.id))?.id === 2) rows.reverse();
  const first = rows.findIndex(row => ids.has(row.id));
  const last = rows.findLastIndex(row => ids.has(row.id));
  if (rows[first]?.id !== 1 || rows[last]?.id !== 2) return;
  const depths = {}, origin = rows[first].thickness / 2;
  let height = 0;
  for (const row of rows.slice(first, last + 1)) {
    if (!Number.isFinite(row.thickness) || row.thickness < 0) return;
    if (ids.has(row.id)) {
      if (Object.hasOwn(depths, row.id)) return;
      depths[row.id] = height + row.thickness / 2 - origin;
    }
    height += row.thickness;
  }
  if (validCopperDepths(depths, layerIds)) return depths;
}

async function readCopperDepths(layerIds) {
  try {
    return stackDepths(await eda.pcb_Layer.getCurrentPhysicalStackingConfiguration?.(), layerIds);
  } catch { /* The stackup API is unavailable in some clients. */ }
}

function estimateCopperDepths(layerIds, thicknessMm) {
  if (layerIds.length < 2) return;
  // Four-layer FR-4 estimate based on the copper-center spacing of JLC04161H-7628.
  const weights = layerIds.length === 4 ? [0.2355, 1.0802, 0.2355] : layerIds.slice(1).map(() => 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let offset = 0;
  return Object.fromEntries(layerIds.map((id, i) => {
    if (i > 0) offset += weights[i - 1];
    return [id, offset / total * thicknessMm];
  }));
}

function padRadius(primitive) {
  const pad = state(primitive, 'Pad');
  if (!Array.isArray(pad) || !['RECT', 'ELLIPSE', 'OVAL'].includes(pad[0])) return 0;
  return Number.isFinite(pad[1]) && Number.isFinite(pad[2]) ? Math.max(0, Math.min(pad[1], pad[2]) / 2) : 0;
}

function rectangularPadOutline(primitive, center) {
  const shape = state(primitive, 'Pad');
  if (shape?.[0] !== 'RECT') return undefined;
  const [, w, h, round = 0] = shape;
  if (![w, h].every(value => Number.isFinite(value) && value > 0) || round !== 0) return undefined;
  const rotation = (Number(state(primitive, 'Rotation')) || 0) * Math.PI / 180;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => point(center.x + x * cos - y * sin, center.y + x * sin + y * cos));
}

function padCoversPoint(pad, position) {
  const center = point(state(pad, 'X'), state(pad, 'Y'));
  if (!validPoint(center)) return false;
  const shape = state(pad, 'Pad');
  const [kind, w, h, round = 0] = Array.isArray(shape) ? shape : [];
  if (!['RECT', 'ELLIPSE', 'OVAL'].includes(kind) || !(w > 0 && h > 0) || ![w, h].every(Number.isFinite)) {
    return distance(center, position) <= SNAP;
  }
  const rotation = (Number(state(pad, 'Rotation')) || 0) * Math.PI / 180;
  const dx = position.x - center.x, dy = position.y - center.y;
  const x = Math.abs(dx * Math.cos(rotation) + dy * Math.sin(rotation));
  const y = Math.abs(-dx * Math.sin(rotation) + dy * Math.cos(rotation));
  const halfW = w / 2, halfH = h / 2;
  if (kind === 'ELLIPSE') return (x / halfW) ** 2 + (y / halfH) ** 2 <= 1;
  if (kind === 'OVAL') {
    const radius = Math.min(halfW, halfH);
    return Math.hypot(Math.max(0, x - halfW + radius), Math.max(0, y - halfH + radius)) <= radius;
  }
  if (x > halfW || y > halfH) return false;
  // Keep the inscribed circle for rounded rectangles, whose corner encoding varies by client.
  return !round || distance(center, position) <= Math.min(halfW, halfH);
}

function readAnchor(primitive, layerIds) {
  const id = state(primitive, 'PrimitiveId'), type = state(primitive, 'PrimitiveType');
  const p = point(state(primitive, 'X'), state(primitive, 'Y'));
  if (!id || !validPoint(p)) return null;
  if (type === 'Via') {
    if (![0, 2].includes(state(primitive, 'ViaType'))) return null;
    return { id, p, layers: layerIds, radius: Number(state(primitive, 'Diameter') || 0) / 2, via: true };
  }
  const layer = state(primitive, 'Layer');
  if (layer === MULTI_LAYER && !state(primitive, 'Metallization')) return null;
  if (layer !== MULTI_LAYER && !layerIds.includes(layer)) return null;
  const outline = layer === MULTI_LAYER ? undefined : rectangularPadOutline(primitive, p);
  return { id, p, layers: layer === MULTI_LAYER ? layerIds : [layer], radius: padRadius(primitive), outline };
}

async function pickComponentPad(hit, position) {
  if (!validPoint(position)) throw new Error('未读取到点击位置，请重新单击焊盘中心。');
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(hit.primitiveId) || [];
  let hitsAtPoint;
  try {
    hitsAtPoint = await eda.pcb_Document.getPrimitiveAtPoint(position.x, position.y);
  } catch { /* Fall back to the known copper near each pin's center. */ }
  const hits = Array.isArray(hitsAtPoint) ? hitsAtPoint : hitsAtPoint ? [hitsAtPoint] : [];
  const directIds = new Set(hits.filter(primitive => ['ComponentPad', 'Pad'].includes(state(primitive, 'PrimitiveType')))
    .map(primitive => state(primitive, 'PrimitiveId')));
  const direct = pins.filter(pin => directIds.has(state(pin, 'PrimitiveId')));
  const matches = direct.length ? direct : pins.filter(pin => padCoversPoint(pin, position));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('点击位置命中多个焊盘，请单击要选的焊盘中心。');
  throw new Error('选中了整个器件。请单击有网络的焊盘中心。');
}

async function pickUnderCopper(position, visibleLayers) {
  if (!validPoint(position) || typeof eda.pcb_Document.getPrimitivesInRegion !== 'function') return undefined;
  const { x, y } = position;
  const around = await eda.pcb_Document.getPrimitivesInRegion(x - 3, x + 3, y + 3, y - 3, false)
    .catch(() => []) || [];
  const pads = new Map();
  for (const item of around) {
    const type = state(item, 'PrimitiveType');
    if (type === 'Pad' || type === 'ComponentPad') {
      pads.set(state(item, 'PrimitiveId'), { primitive: item });
    }
    if (type === 'Component') {
      const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(state(item, 'PrimitiveId')) || [];
      for (const pin of pins) pads.set(state(pin, 'PrimitiveId'), {
        primitive: pin, designator: state(item, 'Designator'),
      });
    }
  }
  const matches = [...pads.values()].filter(({ primitive }) => {
    const layer = state(primitive, 'Layer');
    return (layer === MULTI_LAYER || visibleLayers.includes(layer)) && padCoversPoint(primitive, position);
  });
  if (matches.length > 1) throw new Error('光标下有多个焊盘。请放大后点焊盘中心，或先只显示目标铜层。');
  return matches[0];
}

async function pickPrimitive(hit, position) {
  if (hit.primitiveType === 'Component') return pickComponentPad(hit, position);
  if (hit.primitiveType === 'ComponentPad' && hit.parentComponentPrimitiveId) {
    const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(hit.parentComponentPrimitiveId);
    const pad = pads?.find(p => state(p, 'PrimitiveId') === hit.primitiveId);
    if (pad) return pad;
  }
  const api = {
    Pad: eda.pcb_PrimitivePad,
    Via: eda.pcb_PrimitiveVia,
    Line: eda.pcb_PrimitiveLine,
    Arc: eda.pcb_PrimitiveArc,
    Track: eda.pcb_PrimitiveLine,
    ArcTrack: eda.pcb_PrimitiveArc,
  }[hit.primitiveType];
  if (api) {
    const found = await api.get(hit.primitiveId);
    if (found) return found;
    if (hit.primitiveType === 'Track') {
      const arc = await eda.pcb_PrimitiveArc.get(hit.primitiveId);
      if (arc) return arc;
    }
  }
  const selected = await eda.pcb_SelectControl.getAllSelectedPrimitives();
  return selected.find(p => state(p, 'PrimitiveId') === hit.primitiveId);
}

async function readEndpoint(hit, position, layerIds, visibleLayers = layerIds, density = DEFAULT_CURVE_DENSITY) {
  const covered = copperCoverTypes.includes(hit.primitiveType);
  const trackHit = ['Track', 'ArcTrack', 'Line', 'Arc'].includes(hit.primitiveType);
  const underCopper = covered || trackHit ? await pickUnderCopper(position, visibleLayers) : undefined;
  if (covered && !underCopper) throw new Error('光标落在铺铜区域，未找到被覆盖的可选焊盘。请点击焊盘中心。');
  const primitive = underCopper?.primitive || await pickPrimitive(hit, position);
  if (!primitive) throw new Error('无法读取所选图元。请直接点击焊盘、过孔或导线。');
  const net = state(primitive, 'Net') ?? (underCopper ? undefined : hit.net);
  if (!net) throw new Error('选点没有网络。请点击已分配网络的铜箔图元。');
  const type = state(primitive, 'PrimitiveType') ?? hit.primitiveType;
  const componentDesignator = underCopper?.designator ?? hit.parentComponentDesignator ??
    (hit.primitiveType === 'Component' ? hit.designator : undefined);
  const label = [componentDesignator, state(primitive, 'PadNumber')].filter(Boolean).join('.') ||
    ({ Via: '过孔', Arc: '圆弧走线', Line: '走线' }[type] || '焊盘');
  if (type === 'Line' || type === 'Arc') {
    if (!validPoint(position)) throw new Error('未读取到点击位置，请重试。');
    const track = readTrack(primitive, density);
    if (!layerIds.includes(track.layer)) throw new Error('请选择铜层上的走线。');
    let best;
    for (let i = 1; i < track.points.length; i++) {
      const p = project(position, track.points[i - 1], track.points[i]).p, length = distance(position, p);
      if (!best || length < best.length) best = { p, length };
    }
    return { id: track.id, net, p: best.p, layers: [track.layer], track: true, label };
  }
  const anchor = readAnchor(primitive, layerIds);
  if (!anchor && type === 'Via' && state(primitive, 'ViaType') === 1) {
    throw new Error('该过孔是盲埋孔。扩展无法确定它的起止铜层，请改选金属化多层焊盘或通孔过孔。');
  }
  if (!anchor && ['Pad', 'ComponentPad'].includes(type) &&
      state(primitive, 'Layer') === MULTI_LAYER && !state(primitive, 'Metallization')) {
    throw new Error('该多层焊盘的孔壁未金属化，无法作为跨层端点。');
  }
  if (!anchor) throw new Error('无法读取端点所在的铜层。请重新选择焊盘、普通过孔或走线。');
  return { ...anchor, net, label };
}

async function readNet(net, layerIds, ends, density = DEFAULT_CURVE_DENSITY, checkCancelled = () => {}, trace = () => {}) {
  const warnings = new Set();
  const [primitives, lines, arcs, vias, pads, pours, fills] = await Promise.all([
    eda.pcb_Net.getAllPrimitivesByNet(net).catch(() => undefined),
    eda.pcb_PrimitiveLine.getAll(net),
    eda.pcb_PrimitiveArc.getAll(net),
    eda.pcb_PrimitiveVia.getAll(net),
    eda.pcb_PrimitivePad.getAll(undefined, net),
    eda.pcb_PrimitivePour.getAll(net),
    eda.pcb_PrimitiveFill.getAll(undefined, net),
  ]);
  checkCancelled();
  trace('pcb.primitives', { primitiveRecords: primitives?.length, lines: lines.length, arcs: arcs.length,
    vias: vias.length, pads: pads.length, pours: pours.length, fills: fills.length, layerIds, density });
  const tracks = [...lines, ...arcs].filter(p => layerIds.includes(state(p, 'Layer')) && state(p, 'Net') === net)
    .map(primitive => readTrack(primitive, density));
  // Some desktop clients return raw models here, and filter by model object rather than primitive type.
  const pins = (primitives || []).filter(p => state(p, 'PrimitiveType') === 'ComponentPad');
  let parents = [...new Set((primitives || []).map(p => p.parentId).filter(id => typeof id === 'string' && id))];
  if (!Array.isArray(primitives)) {
    const components = await eda.pcb_PrimitiveComponent.getAll();
    checkCancelled();
    parents = components.map(component => state(component, 'PrimitiveId')).filter(Boolean);
  }
  for (let i = 0; i < parents.length; i += 16) {
    const results = await Promise.allSettled(parents.slice(i, i + 16).map(id =>
      eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id)));
    checkCancelled();
    for (const result of results) {
      if (result.status === 'fulfilled') pins.push(...(result.value || []));
      else warnings.add('部分封装焊盘读取失败，可能漏算相关路径。');
    }
  }
  trace('pcb.component-pads', { componentCount: parents.length, records: pins.length });
  const anchors = new Map();
  for (const primitive of [...pads, ...pins, ...vias]) {
    if (state(primitive, 'Net') !== net) continue;
    const anchor = readAnchor(primitive, layerIds);
    if (anchor) {
      anchors.set(anchor.id, anchor);
    } else if (state(primitive, 'PrimitiveType') === 'Via') {
      warnings.add('盲埋孔未计入，当前 API 未返回可靠的起止铜层。');
    }
  }
  for (const end of ends) if (!end.track) anchors.set(end.id, end);
  const planes = [];
  const copperById = new Map((primitives || []).filter(item => item.pcbItemPrimitiveType === 'Copper')
    .map(item => [item.globalIndex, item]));
  const loadedCopper = new Set();
  const poured = pours.length ? await eda.pcb_PrimitivePoured.getAll() : [];
  checkCancelled();
  trace('pcb.generated-pour', { generatedRecords: poured.length, nativeCopperRecords: copperById.size });
  const pouredByBorder = new Map();
  for (const item of poured) {
    const id = state(item, 'PourPrimitiveId'), list = pouredByBorder.get(id) || [];
    list.push(...(state(item, 'PourFills') || []));
    pouredByBorder.set(id, list);
  }
  for (const border of pours) {
    const layer = state(border, 'Layer'), id = state(border, 'PrimitiveId');
    if (!layerIds.includes(layer) || state(border, 'Net') !== net) continue;
    if (state(border, 'PourFillMethod') !== 'solid') {
      warnings.add('网格覆铜未计入。');
      continue;
    }
    const regions = pouredByBorder.get(id) || [];
    if (!regions.length) warnings.add('存在未生成填充的覆铜边框。请重建覆铜后再分析。');
    for (const [i, region] of regions.entries()) {
      try {
        // V4.1 forwards the generated pour's native 10 mil geometry. Board outlines and ordinary fills
        // use mil already, and arc sweeps are degrees in both formats.
        const regionId = id + ':' + i;
        if (!region.fill) {
          const width = Number(region.lineWidth) * 10;
          if (!(width > 0 && Number.isFinite(width))) throw new Error('缺少覆铜线宽。');
          // A solid pour can contain open, stroked paths for thermal relief spokes.
          const strokes = readPolygonParts(region.path).map(polygon => readPolygon(polygon, false, 10));
          if (strokes.some(points => points.length < 2)) throw new Error('覆铜线段退化。');
          tracks.push(...strokes.map((points, j) => ({
            id: 'spoke:' + regionId + ':' + j, layer, width, points, spoke: true,
          })));
          loadedCopper.add(region.id);
          continue;
        }
        const native = copperById.get(region.id);
        // The editor renders an additional round stroke on optimized copper boundaries.
        const width = Number(native?.optimizationWidth);
        const stroke = native?.optimization === true && Number.isFinite(width) && width > 0 ? width * 10 : 0;
        planes.push({ id: regionId, layer, stroke, rings: readRings(region.path, 10) });
        loadedCopper.add(region.id);
      } catch {
        warnings.add('部分覆铜轮廓或辐条无法读取，已跳过。');
      }
    }
  }
  for (const [id, native] of copperById) {
    if (loadedCopper.has(id) || native.net !== net || native.style !== 'solid' || !layerIds.includes(native.layerId)) continue;
    try {
      const width = Number(native.optimizationWidth);
      const stroke = native.optimization === true && Number.isFinite(width) && width > 0 ? width * 10 : 0;
      planes.push({ id: 'copper:' + id, layer: native.layerId, stroke, rings: readRings(native.copperPath, 10) });
    } catch {
      warnings.add('部分原生铜区轮廓无法读取。');
    }
  }
  for (const item of primitives || []) {
    if (item.type !== 'TearDrop' || item.net !== net || !layerIds.includes(item.layerId)) continue;
    try {
      planes.push({ id: 'teardrop:' + item.globalIndex, layer: item.layerId, rings: readRings(item.pathString) });
    } catch {
      warnings.add('部分泪滴铜箔无法读取。');
    }
  }
  for (const primitive of fills) {
    const layer = state(primitive, 'Layer');
    if (!layerIds.includes(layer) || state(primitive, 'Net') !== net) continue;
    if (state(primitive, 'FillMode') !== 0) {
      warnings.add('非实心填充或独立内电层区域未计入。');
      continue;
    }
    try {
      planes.push({ id: state(primitive, 'PrimitiveId'), layer, rings: readRings(state(primitive, 'ComplexPolygon')) });
    } catch {
      warnings.add('部分实心填充无法读取边界，已跳过。');
    }
  }
  return { tracks, anchors: [...anchors.values()], planes, warnings: [...warnings] };
}
