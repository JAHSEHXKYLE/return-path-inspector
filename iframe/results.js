'use strict';

const BUS = 'return-path-inspector.v1.';
const MAX_PAIRS = 8;
const INACTIVE_COLOR = '#858585';
const INACTIVE_WIDTH = 0.8;
const $ = id => document.getElementById(id);
const label = i => String.fromCharCode(65 + i);
const svgNs = 'http://www.w3.org/2000/svg';
const byName = document.querySelectorAll('input[name=mode]');
const bus = (typeof eda === 'undefined' ? window.eda : eda)?.sys_MessageBus;
let current = null;
let mapping = [];
let pairCount = 0;
let styleLayers = '';
let stackupKey = '';
let depthInputs = [];
let debugLogUrl;
let pendingPreview;
let routeRowsKey, routePageKey;
let drawingKey, fittedBox, zoomBox;
let drawingPan;
let lengthUnit = 'mm';

function routeLength(mil) {
  return (lengthUnit === 'mm' ? mil * 0.0254 : mil).toFixed(3) + ' ' + lengthUnit;
}

function raiseCreatorWatermark(activeDialog) {
  const watermark = $('creatorWatermark');
  if (typeof watermark.showPopover === 'function') {
    try {
      if (watermark.matches(':popover-open')) watermark.hidePopover();
      watermark.showPopover();
      return;
    } catch { watermark.removeAttribute('popover'); }
  }
  const dialog = activeDialog || ($('debugLogDialog').open ? $('debugLogDialog') : $('tutorialDialog'));
  (dialog.open ? dialog : document.body).append(watermark);
}

function action(type, payload = {}) {
  if (current?.progress && !['closed', 'cancel', 'exportLog'].includes(type)) return;
  bus?.publish(BUS + 'action', JSON.stringify({ type, token: current?.token, ...payload }));
}

function requestPreview(fields) {
  if (!bus || !current || current.progress || pendingPreview) return;
  pendingPreview = { id: (current.previewRequest ?? 0) + 1, reveal: fields.diagramRoute };
  updatePreviewStatus();
  action('view', { ...fields, previewRequest: pendingPreview.id });
}

function updatePreviewStatus() {
  $('previewLoading').hidden = !pendingPreview;
  $('routes').setAttribute('aria-busy', String(Boolean(pendingPreview)));
}

function clearDebugLogExport() {
  if (debugLogUrl) URL.revokeObjectURL(debugLogUrl);
  debugLogUrl = undefined;
  $('debugLogText').value = '';
  const link = $('debugLogDownload');
  link.hidden = true;
  link.removeAttribute('href');
  link.removeAttribute('download');
}

function showDebugLogExport(data) {
  if (current?.token !== data?.token || typeof data?.text !== 'string') return;
  clearDebugLogExport();
  $('debugLogText').value = data.text;
  const link = $('debugLogDownload');
  try {
    debugLogUrl = URL.createObjectURL(new Blob(['\uFEFF', data.text], { type: 'text/plain;charset=utf-8' }));
    link.setAttribute('href', debugLogUrl);
    link.setAttribute('download', data.filename);
    link.hidden = false;
  } catch { /* Log text can still be selected in a download-restricted client. */ }
  const dialog = $('debugLogDialog');
  if (!dialog.open) dialog.showModal();
  raiseCreatorWatermark(dialog);
}

function renderPairs(s) {
  if (pairCount === s.pairs.length && $('pairs').childElementCount === s.pairs.length) return;
  pairCount = s.pairs.length;
  $('pairs').replaceChildren();
  for (let i = 0; i < s.pairs.length; i++) {
    mapping[i] ??= i;
    const row = document.createElement('div');
    row.className = 'pair';
    const start = document.createElement('span');
    start.textContent = '起始点 ' + label(i) + '  ·  ' + s.pairs[i].start.label + '  [' + s.pairs[i].start.net + ']';
    start.title = start.textContent;
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    const ends = document.createElement('select');
    ends.setAttribute('aria-label', '起始点 ' + label(i) + ' 对应的流入点');
    for (const [j, pair] of s.pairs.entries()) {
      const option = document.createElement('option');
      option.value = j;
      option.textContent = '流入点 ' + label(j) + '  ·  ' + pair.end.label + '  [' + pair.end.net + ']';
      ends.append(option);
    }
    ends.value = mapping[i];
    ends.addEventListener('change', () => {
      const previous = mapping[i], next = Number(ends.value);
      const other = mapping.indexOf(next);
      mapping[i] = next;
      if (other >= 0 && other !== i) mapping[other] = previous;
      action('pairing', { mapping });
      pairCount = -1;
      renderPairs(s);
    });
    row.append(start, arrow, ends);
    $('pairs').append(row);
  }
}

function colorFor(layer) {
  if (current.colorMode === 'mono') return '#20C9DB';
  if (current.colorMode === 'custom' && current.layerStyles?.[layer]?.color) return current.layerStyles[layer].color;
  return editorColor(layer);
}

function editorColor(layer) {
  const color = current.layers.find(item => item.id === layer)?.color;
  return typeof color === 'string' && /^#?[0-9a-f]{6}$/i.test(color) ? '#' + color.replace('#', '') : '#20C9DB';
}

function widthFor(layer) {
  return current.layerStyles?.[layer]?.width ?? current.defaultPathWidth ?? 3.5;
}

function renderStyleControls() {
  const select = $('styleLayer');
  const signature = current.layers.map(layer => layer.id + ':' + layer.name).join('|');
  if (styleLayers !== signature) {
    styleLayers = signature;
    const previous = Number(select.value);
    select.replaceChildren();
    for (const layer of current.layers) {
      const option = document.createElement('option');
      option.value = layer.id;
      option.textContent = layer.name || '层 ' + layer.id;
      select.append(option);
    }
    select.value = current.layers.some(layer => layer.id === previous) ? previous :
      (current.currentLayer ?? current.layers[0]?.id ?? '');
  }
  const id = Number(select.value);
  $('styleSettings').hidden = !current.layers.length;
  $('styleTitle').textContent = current.layers.length + ' 层板 · 路径样式';
  const color = $('styleColor'), width = $('styleWidth');
  if (document.activeElement !== color) color.value = current.layerStyles?.[id]?.color || editorColor(id);
  if (document.activeElement !== width) width.value = widthFor(id);
}

function svgElement(name, attributes, content) {
  const element = document.createElementNS(svgNs, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (content) element.textContent = content;
  return element;
}

function routeLayers(route) {
  const ids = [...new Set(route.edges.flatMap(edge => edge.layers))];
  return ids.map(id => current.layers.find(item => item.id === id)?.name || '层 ' + id);
}

function viaCount(route) {
  return new Set(route.edges.filter(edge => edge.kind === 'via')
    .map(edge => edge.path[0].x + ':' + edge.path[0].y)).size;
}

function drawingCoordinates(event) {
  const box = zoomBox || fittedBox;
  if (!box) return;
  const rect = $('drawing').getBoundingClientRect();
  const scale = Math.min(rect.width / box[2], rect.height / box[3]);
  if (!(scale > 0)) return;
  return { x: box[0] + box[2] / 2 + (event.clientX - rect.left - rect.width / 2) / scale,
    y: box[1] + box[3] / 2 + (event.clientY - rect.top - rect.height / 2) / scale, scale };
}

function updateDrawingBox() {
  $('drawing').setAttribute('viewBox', (zoomBox || fittedBox || [0, 0, 600, 260]).join(' '));
  $('resetDrawingZoom').disabled = !zoomBox;
}

function zoomDrawing(event) {
  const cursor = drawingCoordinates(event);
  if (!cursor || !event.deltaY) return;
  endDrawingPan();
  event.preventDefault();
  const box = zoomBox || fittedBox;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1);
  const factor = Math.exp(Math.max(-0.8, Math.min(0.8, delta / 420)));
  const width = Math.max(fittedBox[2] / 32, box[2] * factor);
  const ratio = width / box[2];
  zoomBox = width >= fittedBox[2] ? undefined :
    [cursor.x + (box[0] - cursor.x) * ratio, cursor.y + (box[1] - cursor.y) * ratio, width, box[3] * ratio];
  updateDrawingBox();
}

function startDrawingPan(event) {
  if (event.button !== 2) return;
  const cursor = drawingCoordinates(event);
  if (!cursor) return;
  event.preventDefault();
  const svg = $('drawing');
  endDrawingPan();
  drawingPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    scale: cursor.scale, box: (zoomBox || fittedBox).slice() };
  svg.setPointerCapture(event.pointerId);
  svg.setAttribute('data-panning', '');
}

function moveDrawingPan(event) {
  if (!drawingPan || drawingPan.pointerId !== event.pointerId) return;
  if (!(event.buttons & 2)) return endDrawingPan();
  event.preventDefault();
  const { x, y, scale, box } = drawingPan;
  zoomBox = [box[0] - (event.clientX - x) / scale, box[1] - (event.clientY - y) / scale, box[2], box[3]];
  updateDrawingBox();
}

function endDrawingPan(event) {
  if (!drawingPan || (event && event.pointerId !== drawingPan.pointerId)) return;
  const { pointerId } = drawingPan;
  drawingPan = undefined;
  const svg = $('drawing');
  svg.removeAttribute('data-panning');
  if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
}

function selectDrawingRoute(event) {
  if (event.button > 0 || drawingPan || !current?.showAllRoutes || current.progress || pendingPreview) return;
  const cursor = drawingCoordinates(event);
  if (!cursor) return;
  const x = cursor.x, y = -cursor.y;
  const selected = Math.max(0, current.selected);
  let nearest = 7 / cursor.scale, picked;
  const consider = (distance, index) => {
    if (!Number.isSafeInteger(index) || distance > nearest || (picked != null && distance >= nearest - 1e-8)) return;
    nearest = distance;
    picked = index;
  };
  // The selected route wins ties on shared geometry. Other overlaps follow list order.
  for (const [preview, fallback] of [[current.activePreview, selected], [current.inactivePreview, undefined]]) {
    for (const { points, routeIndex = fallback } of preview?.paths || []) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        const fraction = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0;
        consider(Math.hypot(x - a.x - dx * fraction, y - a.y - dy * fraction), routeIndex);
      }
    }
    for (const { p, r, routeIndex = fallback } of preview?.vias || []) {
      consider(Math.abs(Math.hypot(x - p.x, y - p.y) - r), routeIndex);
    }
  }
  if (picked != null && picked !== selected) requestPreview({ diagramRoute: picked });
}

function renderDrawing(result) {
  const svg = $('drawing');
  const key = JSON.stringify([current.token, current.resultRevision, current.mode, current.group]);
  if (key !== drawingKey) {
    endDrawingPan();
    drawingKey = key;
    zoomBox = undefined;
  }
  svg.replaceChildren();
  $('legend').replaceChildren();
  const routes = result?.routes || [];
  if (!routes.length) {
    endDrawingPan();
    fittedBox = zoomBox = undefined;
    updateDrawingBox();
    svg.removeAttribute('data-pickable');
    svg.append(svgElement('text', { x: 300, y: 130, fill: 'currentColor', 'text-anchor': 'middle' }, '等待有效路径'));
    $('viewNote').textContent = '';
    return;
  }
  const other = current.showAllRoutes ? current.inactivePreview : undefined;
  const { paths, vias } = current.activePreview || { paths: [], vias: [] };
  const allPoints = [paths, other?.paths || []].flatMap(items => items.flatMap(path => path.points));
  for (const { p, r } of [...vias, ...(other?.vias || [])]) {
    allPoints.push({ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y + r });
  }
  const bounds = allPoints.reduce((b, p) => [Math.min(b[0], p.x), Math.min(b[1], -p.y),
    Math.max(b[2], p.x), Math.max(b[3], -p.y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const w = Math.max(1, bounds[2] - bounds[0]), h = Math.max(1, bounds[3] - bounds[1]);
  const margin = Math.max(w, h, 40) * 0.13;
  fittedBox = allPoints.length ? [bounds[0] - margin, bounds[1] - margin, w + margin * 2, h + margin * 2] : undefined;
  if (!fittedBox) {
    endDrawingPan();
    zoomBox = undefined;
  }
  updateDrawingBox();
  if (other?.paths.length || other?.vias.length) svg.setAttribute('data-pickable', '');
  else svg.removeAttribute('data-pickable');
  const layerSet = new Set();
  const svgPoint = p => p.x + ',' + -p.y;
  const line = (points, color, width) => svgElement('polyline', {
    points: points.map(svgPoint).join(' '), fill: 'none', stroke: color, 'stroke-width': width,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
  });
  for (const { points } of other?.paths || []) svg.append(line(points, INACTIVE_COLOR, INACTIVE_WIDTH));
  for (const { p, r } of other?.vias || []) {
    svg.append(svgElement('circle', { cx: p.x, cy: -p.y, r, stroke: INACTIVE_COLOR,
      'stroke-width': INACTIVE_WIDTH, 'vector-effect': 'non-scaling-stroke', fill: 'none' }));
  }
  for (const { layer, points } of paths) {
    layerSet.add(layer);
    svg.append(line(points, colorFor(layer), widthFor(layer)));
  }
  for (const { layer, p, r } of vias) {
    layerSet.add(layer);
    svg.append(svgElement('circle', { cx: p.x, cy: -p.y, r, stroke: colorFor(layer),
      'stroke-width': widthFor(layer),
      'vector-effect': 'non-scaling-stroke', fill: 'var(--canvas)' }));
  }
  for (const layer of current.layers.filter(item => layerSet.has(item.id))) {
    const item = document.createElement('span'), chip = document.createElement('i');
    chip.style.backgroundColor = colorFor(layer.id);
    item.append(chip, layer.name || '层 ' + layer.id);
    $('legend').append(item);
  }
  const activeLayerName = current.layers.find(layer => layer.id === current.currentLayer)?.name || '未确定';
  const layerPrefix = current.manualLayer != null ? '已指定铜层' :
    current.activeLayerRead ? '当前显示铜层' : '默认预览铜层';
  $('viewNote').textContent = layerSet.size ?
    layerPrefix + ' · ' + activeLayerName + '。切换显示范围不改变路径长度和排名。' :
    (other?.paths.length || other?.vias.length) ? '当前显示范围仅有未选中的路径。' :
    '当前显示范围没有路径线段。可切换为“全部铜层”查看。';
}

function renderRouteRows(s, page, routes, selected, reveal) {
  const list = $('routes');
  const pageKey = JSON.stringify([s.token, s.resultRevision, s.mode, s.group, page.index]);
  const rowsKey = JSON.stringify([pageKey, routes.length, s.layers.map(layer => [layer.id, layer.name])]);
  if (rowsKey !== routeRowsKey) {
    const top = pageKey === routePageKey ? list.scrollTop : 0;
    list.replaceChildren();
    for (const [i, route] of routes.entries()) {
      const index = page.offset + i;
      const button = document.createElement('button'), title = document.createElement('strong');
      const length = document.createElement('span'), extra = document.createElement('small');
      button.type = 'button';
      button.className = 'route';
      title.textContent = String(index + 1) + (route.parts ? ' · 可行组合' : ' · 可行解');
      extra.textContent = route.parts ? route.parts.map(p => p.label + ' #' + p.index).join('  /  ') :
        routeLayers(route).join(' · ') + '  /  换层位置 ' + viaCount(route);
      button.append(title, length, extra);
      button.addEventListener('click', () => requestPreview({ selected: index }));
      list.append(button);
    }
    list.scrollTop = top;
    routeRowsKey = rowsKey;
    routePageKey = pageKey;
  }
  const active = selected - page.offset;
  for (const [index, row] of Array.from(list.children).entries()) {
    row.setAttribute('aria-pressed', String(active === index));
    row.children[1].textContent = routeLength(routes[index].length);
  }
  const row = list.children[active];
  if (reveal && row) {
    const bounds = list.getBoundingClientRect(), target = row.getBoundingClientRect();
    if (target.top < bounds.top) list.scrollTop += target.top - bounds.top;
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom;
  }
}

function renderResults(s, reveal) {
  const group = $('group');
  group.replaceChildren();
  group.hidden = s.mode === 'joint' || s.groups.length < 2;
  for (const [i, item] of s.groups.entries()) {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = item.label + (item.error ? ' · 未完成' : '');
    group.append(option);
  }
  group.value = s.group;
  const result = s.mode === 'joint' ? s.joint : s.groups[s.group];
  $('resultTitle').textContent = s.mode === 'joint' ? '共同路径 · 总长度' : '分开路径 · 单对长度';
  const unitButton = $('lengthUnit');
  unitButton.setAttribute('data-unit', lengthUnit);
  unitButton.setAttribute('aria-pressed', String(lengthUnit === 'mil'));
  unitButton.setAttribute('aria-label', '当前长度单位为 ' + lengthUnit + '，点击切换到 ' + (lengthUnit === 'mm' ? 'mil' : 'mm'));
  const routes = result?.routes || [];
  const page = s.routePage || { index: 0, offset: 0, count: String(routes.length), pages: '1', hasNext: false };
  const count = page.count;
  const selected = Math.max(0, s.selected);
  $('routePages').hidden = !routes.length;
  $('routePageStatus').textContent = count + ' 条 · ' + (page.index + 1) + ' / ' + page.pages + ' 页';
  $('previousRoutePage').disabled = page.index === 0;
  $('nextRoutePage').disabled = !page.hasNext;
  const visibility = $('routeVisibility');
  visibility.textContent = s.showAllRoutes ? '仅显示选中路径' : '显示全部路径';
  visibility.setAttribute('aria-pressed', Boolean(s.showAllRoutes));
  visibility.disabled = (count === '0' || count === '1') && !s.showAllRoutes;
  $('detail').textContent = result?.error || (routes.length ? '' : '先采集两点，再计算路径。');
  if (routes.length) {
    const active = routes[selected - page.offset] || routes[0];
    if (active.parts) {
      $('detail').textContent = active.parts.map(item => item.label + ' · 路线 ' + item.index + ' · ' + routeLength(item.length)).join(' ｜ ');
    } else {
      const steps = [];
      for (const edge of active.edges) {
        const layers = edge.layers.map(id => s.layers.find(layer => layer.id === id)?.name || '层 ' + id).join('→');
        const last = steps.at(-1);
        if (edge.kind !== 'via' && last?.layers === layers && last.kind === edge.kind) last.length += edge.length;
        else steps.push({ layers, kind: edge.kind, length: edge.length });
      }
      const types = { plane: '铜区', via: '换层', pad: '焊盘连接', track: '走线' };
      $('detail').textContent = steps.map(step => step.layers + ' ' + types[step.kind] +
        (step.kind === 'via' && !step.length ? '（厚度未计）' : ' ' + routeLength(step.length))).join(' → ');
    }
  }
  const warnings = new Set(s.mode === 'joint' ?
    s.groups.flatMap(group => [...group.warnings, ...(group.error ? [group.label + ' ' + group.error] : [])]) :
    result?.warnings || []);
  if (result?.incomplete || (s.mode === 'joint' && s.groups.some(group => group.incomplete))) {
    warnings.add('部分铜箔未能完成建模或校验，列表包含已验证的连通路径。');
  }
  if (s.markerWarning) warnings.add(s.markerWarning);
  $('warnings').replaceChildren();
  for (const warning of warnings) {
    const item = document.createElement('p');
    item.textContent = warning;
    $('warnings').append(item);
  }
  renderRouteRows(s, page, routes, selected, reveal);
  renderDrawing(result);
}

function renderStackup(s) {
  const values = s.stackup?.depths;
  $('stackupSource').textContent = !values ? '当前没有可用的换层距离。' : '来源 · ' +
    ({ physical: 'EDA 物理叠层', manual: '手动铜层深度', estimate: s.layers.length + ' 层板厚估算' })[s.stackup.source];
  $('stackupApply').disabled = s.stackup?.source === 'physical';
  $('useThickness').textContent = s.stackup?.source === 'physical' ? '保存备用板厚' : '按板厚估算';
  const key = JSON.stringify([s.token, s.layers.map(layer => [layer.id, layer.name]), s.stackup, s.boardThicknessMm]);
  if (key === stackupKey) return;
  stackupKey = key;
  $('boardThickness').value = s.boardThicknessMm ?? 1.6;
  const ordered = values ? s.layers.slice().sort((a,b) => values[a.id] - values[b.id]) : [];
  $('layerGaps').textContent = ordered.slice(1).map((layer, i) =>
    ordered[i].name + ' → ' + layer.name + ' ' + (values[layer.id] - values[ordered[i].id]).toFixed(3) + ' mm').join(' ｜ ');
  $('stackupDepths').replaceChildren();
  depthInputs = s.layers.map(layer => {
    const label = document.createElement('label'), input = document.createElement('input');
    label.textContent = layer.name;
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.value = layer.id === 1 ? '0' : values?.[layer.id] ?? '';
    input.readOnly = layer.id === 1 || s.stackup?.source === 'physical';
    label.append(input);
    $('stackupDepths').append(label);
    return [layer.id, input];
  });
}

function render(s) {
  if (current?.token !== s.token) {
    clearDebugLogExport();
    if ($('debugLogDialog').open) $('debugLogDialog').close();
    mapping = [];
    pairCount = -1;
    pendingPreview = undefined;
  }
  const completed = pendingPreview && s.previewRequest === pendingPreview.id ? pendingPreview : undefined;
  if (completed) pendingPreview = undefined;
  current = s;
  updatePreviewStatus();
  const busy = Boolean(s.progress);
  $('exportDebugLog').disabled = false;
  $('calculationProgress').hidden = !busy;
  $('progressStage').textContent = s.progress || '';
  for (const key of ['pick', 'calculate', 'clear', 'close', 'display', 'color', 'curveDensity', 'workspaceWidth', 'stackupApply', 'stackupReset', 'useThickness', 'routeVisibility', 'previousRoutePage', 'nextRoutePage', 'lengthUnit']) $(key).disabled = busy;
  $('configuration').hidden = busy;
  if (busy) {
    $('notice').textContent = '';
    return;
  }
  $('notice').textContent = s.notice || (s.previewLayer ? '已生成非铜层「回流路径预览」。' : '');
  $('pick').disabled = s.pairs.length >= MAX_PAIRS;
  $('calculate').disabled = !s.pairs.length;
  $('clear').disabled = false;
  $('close').disabled = false;
  $('display').disabled = false;
  $('color').disabled = false;
  $('display').value = s.display;
  $('color').value = s.colorMode;
  $('curveDensity').value = String(s.curveDensity ?? 2);
  if (document.activeElement !== $('workspaceWidth')) $('workspaceWidth').value = String(s.workspaceWidth ?? 8);
  renderStyleControls();
  renderStackup(s);
  $('manualLabel').hidden = s.display !== 'current';
  const manual = $('manualLayer');
  manual.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = '自动（优先跟随编辑器）';
  manual.append(automatic);
  for (const layer of s.layers) {
    const option = document.createElement('option');
    option.value = layer.id;
    option.textContent = layer.name || '层 ' + layer.id;
    manual.append(option);
  }
  manual.value = s.manualLayer ?? '';
  renderPairs(s);
  renderResults(s, completed?.reveal != null && completed.reveal === s.selected);
}

$('pick').addEventListener('click', () => action('pick'));
$('clear').addEventListener('click', () => action('clear'));
$('exportDebugLog').addEventListener('click', () => action('exportLog'));
$('debugLogClose').addEventListener('click', () => $('debugLogDialog').close());
$('debugLogDialog').addEventListener('close', () => {
  clearDebugLogExport();
  raiseCreatorWatermark();
});
$('debugLogSelect').addEventListener('click', () => {
  $('debugLogText').focus();
  $('debugLogText').select();
});
$('stackupApply').addEventListener('click', () => action('stackup', {
  depthsMm: Object.fromEntries(depthInputs.map(([id, input]) => [id, input.value === '' ? null : Number(input.value)])),
}));
$('stackupReset').addEventListener('click', () => action('stackup', { reset: true }));
$('useThickness').addEventListener('click', () => action('stackup', {
  useThickness: true, boardThicknessMm: Number($('boardThickness').value),
}));
$('close').addEventListener('click', () => action('close'));
$('usageTutorial').addEventListener('click', () => {
  endDrawingPan();
  const dialog = $('tutorialDialog');
  if (!dialog.open) {
    $('tutorialContent').scrollTop = 0;
    dialog.showModal();
  }
  raiseCreatorWatermark(dialog);
});
$('tutorialClose').addEventListener('click', () => $('tutorialDialog').close());
$('tutorialDialog').addEventListener('close', () => raiseCreatorWatermark());
$('lengthUnit').addEventListener('click', () => {
  if (!current || current.progress) return;
  lengthUnit = lengthUnit === 'mm' ? 'mil' : 'mm';
  renderResults(current);
});
$('calculate').addEventListener('click', () => {
  const mode = [...byName].find(item => item.checked)?.value || 'separate';
  action('calculate', { mode, mapping });
});
$('display').addEventListener('change', () => action('view', { display: $('display').value }));
$('routeVisibility').addEventListener('click', () => requestPreview({ showAllRoutes: !current.showAllRoutes }));
$('previousRoutePage').addEventListener('click', () => requestPreview({ page: current.routePage.index - 1 }));
$('nextRoutePage').addEventListener('click', () => requestPreview({ page: current.routePage.index + 1 }));
$('drawing').addEventListener('wheel', zoomDrawing, { passive: false });
$('drawing').addEventListener('click', selectDrawingRoute);
$('drawing').addEventListener('pointerdown', startDrawingPan);
$('drawing').addEventListener('pointermove', moveDrawingPan);
$('drawing').addEventListener('pointerup', endDrawingPan);
$('drawing').addEventListener('pointercancel', endDrawingPan);
$('drawing').addEventListener('lostpointercapture', endDrawingPan);
$('drawing').addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('blur', () => endDrawingPan());
$('resetDrawingZoom').addEventListener('click', () => {
  endDrawingPan();
  zoomBox = undefined;
  updateDrawingBox();
});
$('color').addEventListener('change', () => action('view', { colorMode: $('color').value }));
$('curveDensity').addEventListener('change', () => action('curveDensity', { value: Number($('curveDensity').value) }));
$('workspaceWidth').addEventListener('change', () => {
  const input = $('workspaceWidth');
  if (input.value === '' || !input.checkValidity()) {
    input.value = String(current.workspaceWidth ?? 8);
    return;
  }
  action('workspaceWidth', { value: Number(input.value) });
});
$('styleLayer').addEventListener('change', renderStyleControls);
$('styleColor').addEventListener('change', () => action('style', {
  layer: Number($('styleLayer').value), color: $('styleColor').value,
}));
$('styleWidth').addEventListener('change', () => {
  const input = $('styleWidth');
  const layer = Number($('styleLayer').value);
  if (input.value === '' || !input.checkValidity()) {
    input.value = widthFor(layer);
    return;
  }
  action('style', { layer, width: Number(input.value) });
});
$('styleReset').addEventListener('click', () => action('style', { layer: Number($('styleLayer').value), reset: true }));
$('manualLayer').addEventListener('change', () => action('view', {
  manualLayer: $('manualLayer').value ? Number($('manualLayer').value) : null,
}));
$('group').addEventListener('change', () => requestPreview({ group: Number($('group').value) }));
window.addEventListener('keydown', event => {
  if ($('tutorialDialog').open) {
    if (event.key === 'Escape') {
      event.preventDefault();
      $('tutorialDialog').close();
    }
    return;
  }
  if (current?.taskActive && event.key === 'Escape') {
    event.preventDefault();
    action('cancel');
    return;
  }
  if (!current || event.repeat || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
      (event.code !== 'KeyS' && event.key?.toLowerCase() !== 's')) return;
  event.preventDefault();
  action('view', { display: current.display === 'current' ? 'follow' : 'current' });
}, true);
raiseCreatorWatermark();
if (bus) {
  bus.subscribe(BUS + 'state', raw => render(typeof raw === 'string' ? JSON.parse(raw) : raw));
  bus.subscribe(BUS + 'debugLog', raw => showDebugLogExport(typeof raw === 'string' ? JSON.parse(raw) : raw));
  action('ready');
  window.addEventListener('pagehide', () => {
    endDrawingPan();
    clearDebugLogExport();
    action('closed');
  });
} else {
  $('notice').textContent = '此窗口需要从嘉立创 EDA 专业版扩展打开。';
}
