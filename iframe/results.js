'use strict';

const BUS = 'return-path-inspector.v1.';
const MAX_PAIRS = 8;
const INACTIVE_COLOR = '#858585';
const INACTIVE_WIDTH = 0.8;
const $ = id => document.getElementById(id);
const label = i => String.fromCharCode(65 + i);
const mm = mil => (mil * 0.0254).toFixed(3);
const svgNs = 'http://www.w3.org/2000/svg';
const byName = document.querySelectorAll('input[name=mode]');
const bus = (typeof eda === 'undefined' ? window.eda : eda)?.sys_MessageBus;
let current = null;
let mapping = [];
let pairCount = 0;
let styleLayers = '';
let stackupKey = '';
let depthInputs = [];

function action(type, payload = {}) {
  if (current?.progress && type !== 'closed' && type !== 'cancel') return;
  bus?.publish(BUS + 'action', JSON.stringify({ type, token: current?.token, ...payload }));
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

function renderDrawing(result) {
  const svg = $('drawing');
  svg.replaceChildren();
  $('legend').replaceChildren();
  const routes = result?.routes || [], visible = new Set(current.visibleLayers);
  if (!routes.length) {
    svg.setAttribute('viewBox', '0 0 600 260');
    svg.append(svgElement('text', { x: 300, y: 130, fill: 'currentColor', 'text-anchor': 'middle' }, '等待有效路径'));
    $('viewNote').textContent = '';
    return;
  }
  const active = routes[current.selected >= 0 ? current.selected : 0] || routes[0];
  const allPoints = routes.flatMap(route => route.edges.flatMap(edge => edge.path));
  if (!allPoints.length) return;
  const bounds = allPoints.reduce((b, p) => [Math.min(b[0], p.x), Math.min(b[1], -p.y),
    Math.max(b[2], p.x), Math.max(b[3], -p.y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const w = Math.max(1, bounds[2] - bounds[0]), h = Math.max(1, bounds[3] - bounds[1]);
  const margin = Math.max(w, h, 40) * 0.13;
  svg.setAttribute('viewBox', [bounds[0] - margin, bounds[1] - margin, w + margin * 2, h + margin * 2].join(' '));
  const layerSet = new Set();
  const drawn = new Set();
  const svgPoint = p => p.x + ',' + -p.y;
  const line = (points, color, width) => svgElement('polyline', {
    points: points.map(svgPoint).join(' '), fill: 'none', stroke: color, 'stroke-width': width,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
  });
  const edgeKey = edge => {
    const coords = edge.path.map(svgPoint);
    const forward = coords.join(' '), reverse = coords.reverse().join(' ');
    return edge.layers[0] + ':' + (forward < reverse ? forward : reverse);
  };
  for (const edge of active.edges) drawn.add(edgeKey(edge));
  let hasInactiveLines = false;
  for (const route of routes) {
    if (route === active) continue;
    for (const edge of route.edges) {
      if (!visible.has(edge.layers[0]) || edge.kind === 'via' || edge.path.length < 2) continue;
      const key = edgeKey(edge);
      if (drawn.has(key)) continue;
      drawn.add(key);
      svg.append(line(edge.path, INACTIVE_COLOR, INACTIVE_WIDTH));
      hasInactiveLines = true;
    }
  }
  const { paths, vias } = current.activePreview || { paths: [], vias: [] };
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
    hasInactiveLines ? '当前显示范围仅有未选中的路径。' :
    '当前显示范围没有路径线段。可切换为“全部铜层”查看。';
}

function renderResults(s) {
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
  $('routes').replaceChildren();
  const routes = result?.routes || [];
  $('detail').textContent = result?.error || (routes.length ? '' : '先采集两点，再计算路径。');
  for (const [i, route] of routes.entries()) {
    const button = document.createElement('button'), title = document.createElement('strong');
    const length = document.createElement('span'), extra = document.createElement('small');
    button.type = 'button';
    button.className = 'route';
    button.setAttribute('aria-pressed', String(s.selected === i || (s.selected === -1 && i === 0)));
    title.textContent = i === 0 ? '1 · 最短候选' : String(i + 1) + ' · 候选路径';
    length.textContent = mm(route.length) + ' mm';
    extra.textContent = route.parts ? route.parts.map(p => p.label + ' #' + p.index).join('  /  ') :
      routeLayers(route).join(' · ') + '  /  换层位置 ' + viaCount(route);
    button.append(title, length, extra);
    button.addEventListener('click', () => action('view', { selected: i }));
    $('routes').append(button);
  }
  if (routes.length) {
    const active = routes[Math.max(0, s.selected)] || routes[0];
    if (active.parts) {
      $('detail').textContent = active.parts.map(item => item.label + ' · 路线 ' + item.index + ' · ' + mm(item.length) + ' mm').join(' ｜ ');
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
        (step.kind === 'via' && !step.length ? '（厚度未计）' : ' ' + mm(step.length) + ' mm')).join(' → ');
    }
  }
  const warnings = new Set(s.mode === 'joint' ?
    s.groups.flatMap(group => [...group.warnings, ...(group.error ? [group.label + ' ' + group.error] : [])]) :
    result?.warnings || []);
  if (result?.truncated) warnings.add('达到候选数量或计算上限，仅显示已找到的最短候选。');
  if (s.markerWarning) warnings.add(s.markerWarning);
  $('warnings').replaceChildren();
  for (const warning of warnings) {
    const item = document.createElement('p');
    item.textContent = warning;
    $('warnings').append(item);
  }
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
    mapping = [];
    pairCount = -1;
  }
  current = s;
  const busy = Boolean(s.progress);
  $('calculationProgress').hidden = !busy;
  $('progressStage').textContent = s.progress || '';
  for (const key of ['pick', 'calculate', 'clear', 'close', 'display', 'color', 'curveDensity', 'workspaceWidth', 'stackupApply', 'stackupReset', 'useThickness']) $(key).disabled = busy;
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
  renderResults(s);
}

$('pick').addEventListener('click', () => action('pick'));
$('clear').addEventListener('click', () => action('clear'));
$('stackupApply').addEventListener('click', () => action('stackup', {
  depthsMm: Object.fromEntries(depthInputs.map(([id, input]) => [id, input.value === '' ? null : Number(input.value)])),
}));
$('stackupReset').addEventListener('click', () => action('stackup', { reset: true }));
$('useThickness').addEventListener('click', () => action('stackup', {
  useThickness: true, boardThicknessMm: Number($('boardThickness').value),
}));
$('close').addEventListener('click', () => action('close'));
$('calculate').addEventListener('click', () => {
  const mode = [...byName].find(item => item.checked)?.value || 'separate';
  action('calculate', { mode, mapping });
});
$('display').addEventListener('change', () => action('view', { display: $('display').value }));
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
$('group').addEventListener('change', () => action('view', { group: Number($('group').value) }));
window.addEventListener('keydown', event => {
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
if (bus) {
  bus.subscribe(BUS + 'state', raw => render(typeof raw === 'string' ? JSON.parse(raw) : raw));
  action('ready');
  window.addEventListener('pagehide', () => action('closed'));
} else {
  $('notice').textContent = '此窗口需要从嘉立创 EDA 专业版扩展打开。';
}
