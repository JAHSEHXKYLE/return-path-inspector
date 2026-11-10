const LIMIT = 80;
const MAX_PAIRS = 8;

function formatLengthMm(mil) {
  return (mil * 0.0254).toFixed(3);
}

function shortestPerDisplayedLength(sortedRoutes) {
  const seen = new Set();
  return sortedRoutes.filter(route => {
    const displayedLength = formatLengthMm(route.length);
    if (seen.has(displayedLength)) return false;
    seen.add(displayedLength);
    return true;
  });
}

function combineRoutes(groups, limit = LIMIT) {
  if (!groups.length || groups.some(group => !group.routes.length)) return { routes: [], truncated: false };
  const heap = new MinHeap(), seen = new Set(), routes = [];
  const enqueue = indices => {
    const key = indices.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    heap.push(indices, indices.reduce((sum, j, i) => sum + groups[i].routes[j].length, 0));
  };
  enqueue(groups.map(() => 0));
  while (heap.size && routes.length < limit) {
    const { value: indices, rank } = heap.pop();
    const parts = indices.map((j, i) => ({
      label: groups[i].label, index: j + 1, length: groups[i].routes[j].length,
      edgeCount: groups[i].routes[j].edges.length,
    }));
    routes.push({ length: rank, parts, edges: indices.flatMap((j, i) => groups[i].routes[j].edges) });
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] + 1 >= groups[i].routes.length) continue;
      const next = indices.slice();
      next[i]++;
      enqueue(next);
    }
  }
  return { routes, truncated: heap.size > 0 || groups.some(group => group.truncated) };
}

const WINDOW_ID = 'return-path-results';
const HINT_ID = 'return-path-task-hint';
const WINDOW_TITLE = '回流路径检查 v' + EXTENSION_VERSION;
const PICK_ID = 'return-path-pick';
const BUS = 'return-path-inspector.v1.';
const LAYER_NAME = '回流路径预览';
const FALLBACK_COLOR = '#20C9DB';
const DEFAULT_WORKSPACE_WIDTH = 8;
const DEFAULT_BOARD_THICKNESS = 1.6;
const savedPreview = new Map();
let session = null;
let queue = Promise.resolve();
let busReady = false;

function logRun(message, type = 'info') {
  try {
    eda.sys_Log?.add('[回流路径] ' + message, type);
  } catch { /* Logging must not interrupt selection or calculation. */ }
}

function enqueue(operation) {
  const result = queue.then(operation);
  queue = result.catch(async error => {
    if (error instanceof PathCancelled) return;
    const message = error?.message || String(error);
    logRun(message, 'error');
    try {
      if (session) {
        session.notice = message;
        send();
      }
      await eda.sys_Dialog.showInformationMessage(message, WINDOW_TITLE);
    } catch { /* The PCB editor may have been closed. */ }
  });
  return queue;
}

function storageKey(doc) {
  return 'preview:' + (doc.parentProjectUuid || '') + ':' + doc.uuid;
}

function normalizeColor(color) {
  return typeof color === 'string' && /^#?[0-9a-f]{6}$/i.test(color) ?
    '#' + color.replace('#', '').toUpperCase() : undefined;
}

function normalizeWidth(width) {
  return Number.isFinite(width) && width >= 0.2 && width <= 8 ? width : undefined;
}

function validCurveDensity(value) {
  return Number.isInteger(value) && value >= 1 && value <= 4;
}

function validWorkspaceWidth(value) {
  return Number.isFinite(value) && value >= 0.2 && value <= 50;
}

function validBoardThickness(value) {
  return Number.isFinite(value) && value > 0 && Number.isFinite(value / 0.0254);
}

function currentStackup(s) {
  const ids = s.layers.map(layer => layer.id);
  if (validCopperDepths(s.autoDepthsMm, ids)) return { source: 'physical', depths: s.autoDepthsMm };
  if (validCopperDepths(s.manualDepthsMm, ids)) return { source: 'manual', depths: s.manualDepthsMm };
  return { source: 'estimate', depths: estimateCopperDepths(ids, s.boardThicknessMm ?? DEFAULT_BOARD_THICKNESS) };
}

function styleKey(doc) {
  return 'style:' + storageKey(doc);
}

async function readStyles(s) {
  try {
    const raw = await eda.sys_Storage.getExtensionUserConfig(styleKey(s.doc));
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const layer of s.layers) {
      const style = saved?.layers?.[layer.id];
      const color = normalizeColor(style?.color), width = normalizeWidth(style?.width);
      if (color || width) s.layerStyles[layer.id] = { color, width };
    }
    if (['layer', 'custom', 'mono'].includes(saved?.mode)) s.colorMode = saved.mode;
    if (validCopperDepths(saved?.depthsMm, s.layers.map(layer => layer.id))) s.manualDepthsMm = saved.depthsMm;
    if (validBoardThickness(saved?.boardThicknessMm)) s.boardThicknessMm = saved.boardThicknessMm;
    if (validCurveDensity(saved?.curveDensity)) s.curveDensity = saved.curveDensity;
    if (validWorkspaceWidth(saved?.workspaceWidth)) s.workspaceWidth = saved.workspaceWidth;
  } catch {
    logRun('无法读取已保存的路径样式，本次使用默认样式。', 'warn');
  }
}

async function writeStyles(s) {
  try {
    if (await eda.sys_Storage.setExtensionUserConfig(styleKey(s.doc),
      JSON.stringify({ mode: s.colorMode, layers: s.layerStyles, depthsMm: s.manualDepthsMm,
        boardThicknessMm: s.boardThicknessMm, curveDensity: s.curveDensity, workspaceWidth: s.workspaceWidth }))) return;
  } catch { /* Keep the edits available for the current session. */ }
  logRun('路径样式已在本次会话应用，未能保存。', 'warn');
}

async function readPreview(doc) {
  const key = storageKey(doc);
  if (savedPreview.has(key)) return savedPreview.get(key);
  const raw = await eda.sys_Storage.getExtensionUserConfig(key);
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const preview = value && Number.isInteger(value.layer) && Array.isArray(value.ids) ?
    { layer: value.layer, kind: value.kind, ids: [...new Set(value.ids.filter(id => typeof id === 'string'))] } :
    { layer: null, ids: [] };
  savedPreview.set(key, preview);
  return preview;
}

async function writePreview(doc, preview) {
  if (!await eda.sys_Storage.setExtensionUserConfig(storageKey(doc), JSON.stringify(preview))) {
    throw new Error('无法保存预览线记录，已停止写入自定义层。');
  }
}

async function currentPcb() {
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (Number(doc?.documentType) !== 3 || !doc.uuid || !doc.tabId) throw new Error('请先打开 PCB 画布。');
  return doc;
}

async function ensureCurrent(doc) {
  const current = await currentPcb();
  if (current.uuid !== doc.uuid || current.tabId !== doc.tabId) throw new Error('PCB 标签页已切换，请回到原画布后重试。');
}

async function clearStoredPreview(doc) {
  await ensureCurrent(doc);
  const preview = await readPreview(doc);
  if (!preview.ids.length || preview.layer == null) return 0;
  const items = await eda.pcb_Layer.getAllLayers();
  if (!items.some(item => item.id === preview.layer && item.type === 'CUSTOM')) {
    preview.ids = [];
    await writePreview(doc, preview);
    return 0;
  }
  const api = preview.kind === 'polyline' ? eda.pcb_PrimitivePolyline : eda.pcb_PrimitiveLine;
  const lines = await api.getAll(undefined, preview.layer);
  const ids = new Set(lines.filter(line => state(line, 'Layer') === preview.layer && !state(line, 'Net'))
    .map(line => state(line, 'PrimitiveId')));
  const own = preview.ids.filter(id => ids.has(id));
  await ensureCurrent(doc);
  if (own.length) await api.delete(own);
  const after = await api.getAll(undefined, preview.layer);
  const live = new Set(after.map(line => state(line, 'PrimitiveId')));
  preview.ids = own.filter(id => live.has(id));
  await writePreview(doc, preview);
  if (preview.ids.length) throw new Error('有 ' + preview.ids.length + ' 条预览线未能删除，请在原 PCB 上再次执行清除。');
  return own.length;
}

async function readBoardForCalculation(s) {
  await ensureCurrent(s.doc);
  const { ids } = await readPreview(s.doc);
  try {
    return await readBoard(ids);
  } catch (error) {
    if (!(error instanceof BoardGeometryError) || !ids.length) throw error;
    checkRunning(s);
    await removeMarkers(s);
    const cleared = await clearStoredPreview(s.doc);
    if (!cleared) throw error;
    s.previewLayer = null;
    s.restorePreview = false;
    s.previewKey = undefined;
    logRun('首次板框校验失败 · ' + error.message, 'warn');
    logRun('已清除 ' + cleared + ' 条旧预览线，正在重新读取板框。');
    await ensureCurrent(s.doc);
    return readBoard();
  }
}

async function savePreview(doc, { paths, vias }, width, checkCancelled = () => {}) {
  const shapes = paths.map(({ points: [start, ...rest] }) =>
    [start.x, start.y, 'L', ...rest.flatMap(p => [p.x, p.y])]);
  for (const { p, r } of vias) shapes.push(['CIRCLE', p.x, p.y, r]);
  if (!shapes.length) return null;
  if (shapes.length > 1800) throw new Error('预览图元超过 1800 个，未写入自定义层。弹窗仍可查看路径。');

  await ensureCurrent(doc);
  checkCancelled();
  const preview = await readPreview(doc);
  const allLayers = await eda.pcb_Layer.getAllLayers();
  if (!allLayers.some(layer => layer.id === preview.layer && layer.type === 'CUSTOM' && layer.name === LAYER_NAME)) {
    const layer = await eda.pcb_Layer.addCustomLayer();
    if (!Number.isInteger(layer)) throw new Error('无法创建非铜预览层，可能已达到自定义层上限。');
    preview.layer = layer;
    await writePreview(doc, preview);
    if (!await eda.pcb_Layer.modifyLayer(layer, { name: LAYER_NAME, color: FALLBACK_COLOR })) {
      throw new Error('无法命名新建的非铜预览层。');
    }
  }

  preview.kind = 'polyline';
  try {
    for (let i = 0; i < shapes.length; i += 12) {
      await ensureCurrent(doc);
      checkCancelled();
      const results = await Promise.allSettled(shapes.slice(i, i + 12).map(async source => {
        const polygon = eda.pcb_MathPolygon.createPolygon(source);
        const line = await eda.pcb_PrimitivePolyline.create('', preview.layer, polygon, width, false);
        const id = state(line, 'PrimitiveId');
        if (!id) throw new Error('创建预览线失败。');
        return id;
      }));
      preview.ids.push(...results.filter(result => result.status === 'fulfilled').map(result => result.value));
      await writePreview(doc, preview);
      checkCancelled();
      if (results.some(result => result.status === 'rejected')) throw new Error('部分预览线创建失败。');
    }
  } catch (error) {
    try {
      await clearStoredPreview(doc);
    } catch (cleanupError) {
      throw new Error(error.message + ' ' + cleanupError.message);
    }
    throw error;
  }
  logRun('已在非铜预览层写入 ' + preview.ids.length + ' 条预览线。');
  return preview.layer;
}

function activeResult(s) {
  return s.mode === 'joint' ? s.joint : s.groups[s.group];
}

function visibleLayer(s, id) {
  const item = s.layers.find(layer => layer.id === id);
  if (!item) return false;
  if (s.display === 'all') return true;
  if (s.display === 'current') return id === s.currentLayer;
  if (s.hostMode === 2 && s.nativeLayer != null) return id === s.nativeLayer;
  return item.status === 1;
}

function publicSession(s) {
  return {
    token: s.token, notice: s.notice, progress: s.progress, pairs: s.pairs, groups: s.groups, joint: s.joint,
    mode: s.mode, group: s.group, selected: s.selected, layers: s.layers,
    currentLayer: s.currentLayer, activeLayerRead: s.activeLayerRead, manualLayer: s.manualLayer,
    display: s.display, colorMode: s.colorMode, layerStyles: s.layerStyles, defaultPathWidth: 3.5,
    curveDensity: s.curveDensity, workspaceWidth: s.workspaceWidth, activePreview: s.activePreview,
    visibleLayers: s.layers.filter(layer => visibleLayer(s, layer.id)).map(layer => layer.id),
    previewLayer: s.previewLayer, markerWarning: s.markerWarning,
    manualDepthsMm: s.manualDepthsMm, autoDepthsMm: s.autoDepthsMm,
    boardThicknessMm: s.boardThicknessMm, stackup: currentStackup(s), taskActive: Boolean(s.hint),
  };
}

function send() {
  if (session?.windowOpen) eda.sys_MessageBus.publish(BUS + 'state', JSON.stringify(publicSession(session)));
}

function notify(text) {
  eda.sys_ToastMessage.showMessage(text);
}

async function readView(s) {
  await ensureCurrent(s.doc);
  const [layers, active, config] = await Promise.all([
    eda.pcb_Layer.getAllLayers(),
    eda.pcb_Layer.getCurrentLayer?.(),
    eda.pcb_Document.getCurrentFilterConfiguration?.().catch(() => undefined),
  ]);
  const before = JSON.stringify([s.layers, s.currentLayer, s.hostMode, s.activeLayerRead]);
  s.layers = copperLayers(layers);
  const shown = s.layers.filter(layer => layer.status === 1);
  const exposed = s.layers.some(layer => layer.id === active?.id) ? active.id :
    shown.length === 1 ? shown[0].id : undefined;
  s.nativeLayer = exposed;
  s.activeLayerRead = exposed != null;
  if (!s.layers.some(layer => layer.id === s.manualLayer)) s.manualLayer = null;
  const previous = s.layers.find(layer => layer.id === s.currentLayer);
  s.currentLayer = s.manualLayer ?? exposed ?? previous?.id ?? shown[0]?.id ?? s.layers[0]?.id;
  const mode = active?.inactiveLayerDisplayMode ?? config?.inactiveLayerDisplayMode;
  s.hostMode = [0, 1, 2].includes(Number(mode)) ? Number(mode) : undefined;
  return JSON.stringify([s.layers, s.currentLayer, s.hostMode, s.activeLayerRead]) !== before;
}

function markerLine(a, b) {
  return { type: 'line', startX: a.x, startY: a.y, endX: b.x, endY: b.y };
}

function markerColor(color, alpha) {
  const hex = (normalizeColor(color) || FALLBACK_COLOR).slice(1);
  const n = Number.parseInt(hex, 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, alpha };
}

async function removeMarkers(s) {
  if (!s.drawn) return;
  s.drawn = false;
  await eda.dmt_EditorControl.removeIndicatorMarkers(s.doc.tabId);
}

async function drawMarkers(s) {
  await ensureCurrent(s.doc);
  await removeMarkers(s);
  s.markerWarning = '';
  if (!s.windowOpen || !s.activePreview) return;
  const groups = new Map();
  const add = (shape, layer) => {
    const style = s.layerStyles[layer];
    const edaColor = s.layers.find(item => item.id === layer)?.color;
    const color = s.colorMode === 'mono' ? FALLBACK_COLOR :
      (s.colorMode === 'custom' ? style?.color : undefined) || edaColor;
    if (!groups.has(color)) groups.set(color, { color: markerColor(color, 1), shapes: [] });
    groups.get(color).shapes.push(shape);
  };
  for (const { layer, points } of s.activePreview.paths) {
    for (let i = 1; i < points.length; i++) add(markerLine(points[i - 1], points[i]), layer);
  }
  for (const { layer, p, r } of s.activePreview.vias) {
    add({ type: 'circle', x: p.x, y: p.y, r }, layer);
  }

  if ([...groups.values()].reduce((sum, group) => sum + group.shapes.length, 0) > 2800) {
    s.markerWarning = '画布标记超出显示上限，将尝试使用预览层。';
    return;
  }
  for (const { shapes, color } of groups.values()) {
    try {
      if (!await eda.dmt_EditorControl.generateIndicatorMarkers(shapes, color, s.workspaceWidth, false, s.doc.tabId)) {
        throw new Error('画布标记不可用。');
      }
      s.drawn = true;
    } catch {
      await removeMarkers(s);
      s.markerWarning = '当前客户端未能绘制画布标记，将尝试使用预览层。';
      break;
    }
  }
}

function startViewPolling(s) {
  const tick = () => setTimeout(() => {
    if (session !== s || !s.windowOpen) return;
    void enqueue(async () => {
      try {
        if (session === s && s.windowOpen && await readView(s)) {
          await refreshWorkspacePreview(s);
          send();
        }
      } catch { /* Another editor tab may be active. */ }
      if (session === s && s.windowOpen) tick();
    });
  }, 500);
  tick();
}

async function hidePreviewLayer(s) {
  if (!s.previewLayer) return;
  const all = await eda.pcb_Layer.getAllLayers();
  const item = all.find(layer => layer.id === s.previewLayer && layer.type === 'CUSTOM');
  if (item?.layerStatus === 1) {
    if (await eda.pcb_Layer.setLayerInvisible(s.previewLayer)) s.restorePreview = true;
  }
}

async function restorePreviewLayer(s, useAsFallback = false) {
  if ((!s.restorePreview && !useAsFallback) || !s.previewLayer || s.previewStale) return;
  await ensureCurrent(s.doc);
  if (await eda.pcb_Layer.setLayerVisible(s.previewLayer, false)) s.restorePreview = false;
}

async function refreshWorkspacePreview(s) {
  await ensureCurrent(s.doc);
  checkRunning(s);
  const routes = activeResult(s)?.routes || [];
  const route = routes[Math.max(0, s.selected)] || routes[0];
  if (!s.previewBoard) return;
  s.activePreview = buildRoutePreview(route, layer => visibleLayer(s, layer), s.curveDensity,
    s.previewBoard, s.previewRegions);
  const key = JSON.stringify([s.workspaceWidth, s.activePreview]);
  let storageWarning = '';
  if (key !== s.previewKey) {
    try {
      await clearStoredPreview(s.doc);
      s.previewStale = false;
      const layer = await savePreview(s.doc, s.activePreview, s.workspaceWidth, () => checkRunning(s));
      if (layer) {
        s.previewLayer = layer;
        if (s.progress) s.wrotePreview = true;
      } else {
        await restorePreviewLayer(s);
        s.previewLayer = null;
      }
      s.previewKey = key;
    } catch (error) {
      if (error instanceof PathCancelled) throw error;
      s.previewStale = true;
      s.previewKey = undefined;
      storageWarning = '预览层更新失败：' + error.message;
      logRun(storageWarning, 'warn');
      try {
        await ensureCurrent(s.doc);
        s.previewLayer ??= (await readPreview(s.doc)).layer;
        await hidePreviewLayer(s);
      } catch { /* Keep the original error visible if the editor tab has changed. */ }
    }
  }
  checkRunning(s);
  await drawMarkers(s);
  checkRunning(s);
  if (s.drawn && !s.markerWarning) await hidePreviewLayer(s);
  else await restorePreviewLayer(s, true);
  if (storageWarning) s.markerWarning = [s.markerWarning, storageWarning].filter(Boolean).join(' ');
}

async function openResults(s) {
  if (s.windowOpen) {
    await eda.sys_IFrame.showIFrame(WINDOW_ID);
    if (s.hintOpen) await eda.sys_IFrame.showIFrame(HINT_ID);
    send();
    return;
  }
  s.windowOpen = true;
  const opened = await eda.sys_IFrame.openIFrame('/iframe/index.html', 990, 680, WINDOW_ID, {
    title: WINDOW_TITLE,
    grayscaleMask: false,
    maximizeButton: true,
  });
  if (!opened) {
    s.windowOpen = false;
    throw new Error('无法打开路径列表弹窗。');
  }
  startViewPolling(s);
  if (s.hintOpen) await eda.sys_IFrame.showIFrame(HINT_ID);
  send();
}

function stopPicking() {
  if (eda.pcb_Event.isEventListenerAlreadyExist(PICK_ID)) eda.pcb_Event.removeEventListener(PICK_ID);
}

class PathCancelled extends Error {}

function checkRunning(s) {
  if (s.cancelled) throw new PathCancelled('已取消回流路径检查。');
}

function sendHint(s) {
  eda.sys_MessageBus.publish(BUS + 'hint', JSON.stringify({ token: s.token, text: s.hint, calculating: Boolean(s.progress) }));
}

async function openHint(s, viewportWidth) {
  const width = viewportWidth ? Math.min(680, viewportWidth - 32) : 680;
  const position = viewportWidth ? { x: Math.round((viewportWidth - width) / 2), y: 96 } : {};
  s.hintOpen = await eda.sys_IFrame.openIFrame('/iframe/hint.html', width, 38, HINT_ID, {
    title: WINDOW_TITLE, grayscaleMask: false, ...position,
    onBeforeCloseCallFn: () => {
      if (s.hintOpen) {
        s.hintOpen = false;
        requestCancel(s);
      }
    },
  });
}

async function showHint(s, text) {
  s.hint = text;
  if (!s.hintAttempted) {
    s.hintAttempted = true;
    let timer;
    try {
      if (s.hintViewportWidth) {
        await openHint(s, s.hintViewportWidth);
      } else {
        // The hint frame can measure its same-origin parent; the menu script has no window.
        const ready = new Promise(resolve => { s.resolveHintReady = resolve; });
        await openHint(s);
        if (s.hintOpen) {
          const timeout = new Promise(resolve => { timer = setTimeout(resolve, 250); });
          const viewportWidth = await Promise.race([ready, timeout]);
          if (viewportWidth && s.hintOpen && !s.cancelled) {
            s.hintOpen = false;
            const closed = await eda.sys_IFrame.closeIFrame(HINT_ID);
            if (!closed) s.hintOpen = true;
            else if (!s.cancelled) await openHint(s, viewportWidth);
          }
        }
      }
    } catch {
      s.hintOpen = false;
    } finally {
      s.resolveHintReady = undefined;
      if (timer != null) clearTimeout(timer);
    }
    if (!s.hintOpen) notify(text);
  }
  sendHint(s);
  checkRunning(s);
}

async function closeHint(s) {
  s.hint = '';
  s.hintAttempted = false;
  if (!s.hintOpen) return;
  s.hintOpen = false;
  await eda.sys_IFrame.closeIFrame(HINT_ID);
}

function requestCancel(s) {
  if (session !== s || !s.hint || s.cancelled) return;
  s.cancelled = true;
  stopPicking();
  return enqueue(async () => {
    s.pending = null;
    await closeHint(s);
    if (s.windowOpen) {
      s.windowOpen = false;
      await eda.sys_IFrame.closeIFrame(WINDOW_ID);
    }
    await removeMarkers(s);
    if (s.restorePreview) await restorePreviewLayer(s);
    logRun('已取消回流路径检查。');
  });
}

async function startPick(s, quick) {
  await ensureCurrent(s.doc);
  if (s.pairs.length >= MAX_PAIRS) throw new Error('最多可检查 ' + MAX_PAIRS + ' 对端点。');
  stopPicking();
  s.pending = null;
  if (s.windowOpen) await eda.sys_IFrame.hideIFrame(WINDOW_ID);
  await eda.pcb_SelectControl.clearSelected();
  const pairLetter = letter(s.pairs.length);
  logRun('开始' + (quick ? '单对' : '多对') + '选点，等待起始点 ' + pairLetter + '。');
  await showHint(s, '请在 PCB 上单击起始点 ' + pairLetter + '（焊盘、过孔或走线）。');
  let lastIgnoredType;
  eda.pcb_Event.addMouseEventListener(PICK_ID, 'selected', (_, hits) => {
    if (session !== s || s.pickBusy || s.cancelled) return;
    const hit = pickable.map(type => hits?.find(item => item.primitiveType === type)).find(Boolean);
    if (!hit) {
      const types = [...new Set((hits || []).map(item => item.primitiveType).filter(Boolean))].join('、');
      if (types && types !== lastIgnoredType) {
        lastIgnoredType = types;
        logRun('选点未命中焊盘、过孔或走线。编辑器报告的图元类型为 ' + types + '。', 'warn');
      }
      return;
    }
    s.pickBusy = true;
    // Read the cursor immediately, before awaiting the remaining API lookups.
    const cursor = pointPickTypes.includes(hit.primitiveType) ?
      eda.pcb_SelectControl.getCurrentMousePosition().catch(() => undefined) : Promise.resolve(undefined);
    void enqueue(async () => {
      try {
        if (session !== s || !eda.pcb_Event.isEventListenerAlreadyExist(PICK_ID)) return;
        await ensureCurrent(s.doc);
        const endpoint = await readEndpoint(hit, await cursor, s.layers.map(layer => layer.id),
          s.layers.filter(layer => layer.status === 1).map(layer => layer.id), s.curveDensity);
        checkRunning(s);
        if (s.pending?.id === endpoint.id && distance(s.pending.p, endpoint.p) < SNAP) {
          logRun('再次命中起始点，请选择不同的流入点。', 'warn');
          notify('请选择不同的流入点。');
          return;
        }
        const layerNames = endpoint.layers.map(id => s.layers.find(layer => layer.id === id)?.name || id).join(' / ');
        logRun('已选' + (s.pending ? '流入点 ' : '起始点 ') + pairLetter + ' · ' + endpoint.label +
          ' · 网络 ' + endpoint.net + ' · 铜层 ' + layerNames + ' · 命中类型 ' + hit.primitiveType +
          ' · 坐标 (' + endpoint.p.x.toFixed(2) + ', ' + endpoint.p.y.toFixed(2) + ') mil。');
        lastIgnoredType = undefined;
        if (!s.pending) {
          s.pending = endpoint;
          await eda.pcb_SelectControl.clearSelected();
          await showHint(s, '已选 ' + endpoint.label + '（' + endpoint.net + '）。请单击流入点 ' + pairLetter + '。');
          return;
        }
        s.pairs.push({ start: s.pending, end: endpoint });
        s.pending = null;
        stopPicking();
        if (quick) {
          try {
            await calculate(s, 'separate', [0]);
          } catch (error) {
            s.pairs = [];
            throw error;
          }
        } else {
          s.notice = '已采集 ' + s.pairs.length + ' 对端点。可以继续采集或开始计算。';
          await openResults(s);
          await showHint(s, s.notice);
        }
      } catch (error) {
        if (!(error instanceof PathCancelled)) throw error;
      } finally {
        s.pickBusy = false;
      }
    });
  }, false);
}

const letter = index => String.fromCharCode(65 + index);

async function reportProgress(s, text) {
  checkRunning(s);
  s.progress = text;
  await showHint(s, text);
  send();
  await new Promise(resolve => setTimeout(resolve, 32));
  checkRunning(s);
}

async function solveWithProgress(s, label, model, pair, board) {
  const search = routeSearch(model, pair.start, pair.end, board, LIMIT);
  let lastPaint = Date.now();
  for (let step = search.next(); ; step = search.next()) {
    if (step.done) return step.value;
    const text = label + ' · ' + step.value;
    if (s.progress !== text || Date.now() - lastPaint >= 100) {
      await reportProgress(s, text);
      lastPaint = Date.now();
    }
  }
}

async function calculate(s, mode, mapping) {
  try {
    await calculatePaths(s, mode, mapping);
  } catch (error) {
    if (!s.cancelled) throw error;
    if (!(error instanceof PathCancelled)) logRun(error.message, 'warn');
    if (s.wrotePreview) await clearStoredPreview(s.doc);
  } finally {
    s.wrotePreview = false;
    s.progress = '';
    if (!s.cancelled) {
      await closeHint(s);
      send();
    }
  }
}

async function calculatePaths(s, mode, mapping) {
  const startedAt = Date.now();
  await ensureCurrent(s.doc);
  if (!s.pairs.length || !Array.isArray(mapping) || mapping.length !== s.pairs.length ||
    new Set(mapping).size !== mapping.length || mapping.some(i => !Number.isInteger(i) || i < 0 || i >= s.pairs.length)) {
    throw new Error('请为每个起始点选择不同的流入点。');
  }
  const pairs = s.pairs.map((pair, i) => ({
    start: pair.start, end: s.pairs[mapping[i]].end, label: letter(i) + '→' + letter(mapping[i]),
  }));
  logRun('开始' + (mode === 'joint' ? '共同' : '分开') + '计算，配对 ' + pairs.map(pair => pair.label).join('、') + '。');
  const good = pairs.filter(pair => {
    if (pair.start.net && pair.start.net === pair.end.net) return true;
    pair.error = '网络不同（' + pair.start.net + ' / ' + pair.end.net + '），未计算。';
    return false;
  });
  if (pairs.length === 1 && !good.length) throw new Error(pairs[0].error);
  if (mode === 'joint' && good.length < pairs.length) {
    throw new Error(pairs.filter(pair => pair.error).map(pair => pair.label + ' ' + pair.error).join('\n'));
  }
  s.notice = '';
  s.progress = '正在校验闭合板框';
  await openResults(s);
  await reportProgress(s, s.progress);
  const board = good.length ? await readBoardForCalculation(s) : null;
  checkRunning(s);
  for (const pair of good) {
    try { validateEnds(pair.start, pair.end, board); }
    catch (error) { pair.error = error.message; }
  }
  const invalid = pairs.filter(pair => pair.error);
  if (invalid.length && (mode === 'joint' || invalid.length === pairs.length)) {
    throw new Error(invalid.map(pair => pair.label + ' ' + pair.error).join('\n'));
  }
  logRun('网络与闭合板框校验通过 ' + (pairs.length - invalid.length) + '/' + pairs.length + ' 对。');

  await removeMarkers(s);
  const cleared = await clearStoredPreview(s.doc);
  if (cleared) logRun('重新计算前已清除 ' + cleared + ' 条旧预览线。');
  s.previewLayer = null;
  s.restorePreview = false;
  s.previewKey = undefined;
  s.previewStale = false;
  s.activePreview = undefined;
  s.previewBoard = board;
  s.groups = [];
  s.joint = { routes: [], truncated: false };
  const layerIds = s.layers.map(layer => layer.id);
  await reportProgress(s, '正在读取物理叠层');
  await ensureCurrent(s.doc);
  s.autoDepthsMm = await readCopperDepths(layerIds);
  const stackup = currentStackup(s);
  const depthsMm = stackup.depths;
  if (depthsMm) logRun('换层距离来源 · ' + ({ physical: 'EDA 物理叠层', manual: '手动铜层深度',
    estimate: '板厚 ' + s.boardThicknessMm + ' mm · ' + layerIds.length + ' 层估算' })[stackup.source] + '。');
  const models = new Map();
  for (const [index, pair] of pairs.entries()) {
    const group = { ...pair, routes: [], warnings: [], truncated: false };
    if (!pair.error) {
      try {
        const label = '第 ' + (index + 1) + ' / ' + pairs.length + ' 对 ' + pair.label;
        await reportProgress(s, label + ' · 读取同网络铜箔');
        await ensureCurrent(s.doc);
        const net = pair.start.net;
        if (!models.has(net)) {
          const ends = pairs.filter(item => !item.error && item.start.net === net).flatMap(item => [item.start, item.end]);
          models.set(net, await readNet(net, layerIds, ends, s.curveDensity));
        }
        checkRunning(s);
        const model = models.get(net);
        Object.assign(group, await solveWithProgress(s, label, { ...model, depthsMm }, pair, board));
        if (mode === 'separate') group.routes = shortestPerDisplayedLength(group.routes);
        const beforeMerge = group.routes.length;
        group.routes = shortestPerSimilarPath(group.routes);
        if (group.routes.length < beforeMerge) {
          logRun(group.label + ' · 已合并 ' + (beforeMerge - group.routes.length) + ' 条走向相近的候选。');
        }
        if (depthsMm && stackup.source === 'estimate' && model.anchors.some(anchor => anchor.layers.length > 1)) {
          group.warnings.push('换层距离按 ' + s.boardThicknessMm + ' mm 板厚估算，可在「过孔与换层长度」中调整。');
        }
        if (!group.routes.length) group.error = group.incomplete || group.truncated
          ? '搜索达到容量上限，未能确认这对点是否连通。'
          : '在已建模的同网络铜箔内未找到连通路径。';
      } catch (error) {
        if (error instanceof PathCancelled) throw error;
        group.error = error.message;
      }
    }
    if (group.error) {
      logRun(group.label + ' · ' + group.error, pair.error ? 'error' : 'warn');
    } else {
      logRun(group.label + ' · ' + group.routes.length + ' 条候选 · 最短 ' +
        formatLengthMm(group.routes[0].length) + ' mm。');
    }
    for (const warning of group.warnings) logRun(group.label + ' · ' + warning, 'warn');
    if (group.truncated) logRun(group.label + ' · 已达到候选数量或计算上限。', 'warn');
    s.groups.push(group);
  }
  s.mode = mode;
  s.group = Math.max(0, s.groups.findIndex(group => group.routes.length));
  s.selected = -1;
  s.joint = combineRoutes(s.groups);
  s.previewRegions = new Map();
  for (const model of models.values()) {
    for (const plane of model.planes) {
      const edges = plane.rings.flatMap(ringEdges);
      s.previewRegions.set(plane.id, { contains: copperContains(edges, boundsOf(edges)), boundary: edges.concat(board.edges) });
    }
  }
  s.notice = mode === 'joint' && !s.joint.routes.length ? '至少有一对没有可用路径，无法组成共同路线。' : '';
  if (s.notice) logRun(s.notice, 'warn');
  await reportProgress(s, '正在生成路径列表和画布预览');
  await refreshWorkspacePreview(s);
  checkRunning(s);
  if (s.markerWarning) logRun(s.markerWarning, 'warn');
  logRun('计算结束，' + (mode === 'joint' ? '共同候选 ' + s.joint.routes.length + ' 条，' : '') +
    '耗时 ' + (Date.now() - startedAt) + ' ms。');
  send();
}

function installBus() {
  if (busReady) return;
  eda.sys_MessageBus.subscribe(BUS + 'action', raw => {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (data?.type === 'ready') {
      send();
      return;
    }
    if (data?.type === 'hintReady') {
      if (session?.hint) {
        const width = data.viewportWidth;
        session.hintViewportWidth = Number.isFinite(width) && width > 32 ? width : undefined;
        session.resolveHintReady?.(session.hintViewportWidth);
        sendHint(session);
      }
      return;
    }
    if (data?.type === 'cancel') {
      if (session?.token === data.token) void requestCancel(session);
      return;
    }
    void enqueue(async () => {
      const s = session;
      if (!s || !data || !s.windowOpen || s.cancelled) return;
      if (data.token !== s.token) return;
      if (data.type === 'pick') {
        await startPick(s, false);
      } else if (data.type === 'calculate') {
        await calculate(s, data.mode === 'joint' ? 'joint' : 'separate', data.mapping);
      } else if (data.type === 'clear') {
        await clear(s);
      } else if (data.type === 'curveDensity') {
        if (!validCurveDensity(data.value) || s.curveDensity === data.value) return;
        await ensureCurrent(s.doc);
        s.curveDensity = data.value;
        await writeStyles(s);
        s.notice = '圆角密度已更新。重新计算可应用新的原生圆弧采样。';
        await refreshWorkspacePreview(s);
        send();
      } else if (data.type === 'workspaceWidth') {
        if (!validWorkspaceWidth(data.value) || s.workspaceWidth === data.value) return;
        await ensureCurrent(s.doc);
        s.workspaceWidth = data.value;
        await writeStyles(s);
        await refreshWorkspacePreview(s);
        send();
      } else if (data.type === 'stackup') {
        await ensureCurrent(s.doc);
        const layerIds = s.layers.map(layer => layer.id);
        if (data.useThickness) {
          if (!validBoardThickness(data.boardThicknessMm)) throw new Error('请输入大于 0 的板厚（mm）。');
          s.boardThicknessMm = data.boardThicknessMm;
          s.manualDepthsMm = undefined;
        } else if (data.reset) {
          s.manualDepthsMm = undefined;
        } else if (validCopperDepths(data.depthsMm, layerIds)) {
          s.manualDepthsMm = data.depthsMm;
        } else {
          throw new Error('请填写全部铜层的深度（mm）。顶层为 0，底层最深，各层深度须不同。');
        }
        await writeStyles(s);
        s.notice = '换层长度设置将在下次计算时应用。';
        send();
      } else if (data.type === 'close' || data.type === 'closed') {
        s.windowOpen = false;
        await closeHint(s);
        await removeMarkers(s);
        await restorePreviewLayer(s);
        if (data.type === 'close') await eda.sys_IFrame.closeIFrame(WINDOW_ID);
      } else if (data.type === 'style') {
        await readView(s);
        if (!s.layers.some(layer => layer.id === data.layer)) return;
        const style = s.layerStyles[data.layer] || {};
        const color = normalizeColor(data.color), width = normalizeWidth(data.width);
        if (data.reset === true) {
          delete s.layerStyles[data.layer];
        } else if (color || width) {
          s.layerStyles[data.layer] = { ...style, ...(color ? { color } : {}), ...(width ? { width } : {}) };
          if (color) s.colorMode = 'custom';
        } else {
          return;
        }
        await writeStyles(s);
        await refreshWorkspacePreview(s);
        send();
      } else if (data.type === 'view') {
        if (['layer', 'custom', 'mono'].includes(data.colorMode) && s.colorMode !== data.colorMode) {
          s.colorMode = data.colorMode;
          await writeStyles(s);
        }
        if (['follow', 'current', 'all'].includes(data.display)) s.display = data.display;
        if (data.manualLayer === null || s.layers.some(layer => layer.id === data.manualLayer)) {
          s.manualLayer = data.manualLayer;
        }
        if (Number.isInteger(data.group) && data.group >= 0 && data.group < s.groups.length) {
          s.group = data.group;
          s.selected = -1;
        }
        const result = activeResult(s);
        if (Number.isInteger(data.selected) && data.selected >= -1 && data.selected < (result?.routes.length || 0)) {
          s.selected = data.selected;
        }
        await readView(s);
        await refreshWorkspacePreview(s);
        send();
      }
    });
  });
  busReady = true;
}

async function clear(s) {
  await ensureCurrent(s.doc);
  stopPicking();
  await removeMarkers(s);
  const count = await clearStoredPreview(s.doc);
  s.groups = [];
  s.joint = { routes: [], truncated: false };
  s.activePreview = undefined;
  s.previewBoard = undefined;
  s.previewRegions = undefined;
  s.previewKey = undefined;
  s.previewStale = false;
  s.previewLayer = null;
  s.restorePreview = false;
  s.markerWarning = '';
  s.notice = '已清除 ' + count + ' 条预览线。';
  logRun(s.notice);
  send();
  notify(s.notice);
}

async function newSession(quick) {
  const doc = await currentPcb();
  installBus();
  stopPicking();
  const old = session;
  if (old) {
    await closeHint(old);
    await removeMarkers(old);
    if (old.restorePreview && old.doc.tabId === doc.tabId) await restorePreviewLayer(old);
    if (old.windowOpen) {
      old.windowOpen = false;
      await eda.sys_IFrame.closeIFrame(WINDOW_ID);
    }
  }
  const s = {
    doc, token: String(Date.now()) + Math.random(), pairs: [], groups: [], joint: { routes: [], truncated: false },
    mode: 'separate', group: 0, selected: -1, colorMode: 'layer', display: 'follow', layerStyles: {},
    curveDensity: DEFAULT_CURVE_DENSITY,
    workspaceWidth: DEFAULT_WORKSPACE_WIDTH,
    windowOpen: false, drawn: false, restorePreview: false, notice: '', markerWarning: '', boardThicknessMm: DEFAULT_BOARD_THICKNESS,
  };
  session = s;
  await readView(s);
  if (!s.layers.length) throw new Error('当前 PCB 没有可分析的铜层。');
  await readStyles(s);
  if (quick) await startPick(s, true);
  else {
    s.autoDepthsMm = await readCopperDepths(s.layers.map(layer => layer.id));
    await openResults(s);
    await showHint(s, '点击「采集下一对点」开始选点，采集完成后点击「计算」。');
    send();
  }
}

function checkReturnPath() { return enqueue(() => newSession(true)); }
function checkMultiplePaths() { return enqueue(() => newSession(false)); }
function showRunLog() {
  return enqueue(() => eda.sys_PanelControl.openBottomPanel('log'));
}
function clearReturnPaths() {
  return enqueue(async () => {
    const doc = await currentPcb();
    if (session?.doc.uuid === doc.uuid && session.doc.tabId === doc.tabId) {
      await clear(session);
    } else {
      const count = await clearStoredPreview(doc);
      const message = '已清除 ' + count + ' 条预览线。';
      logRun(message);
      notify(message);
    }
  });
}
function cancelPicking() {
  if (session?.hint) return requestCancel(session);
  return enqueue(async () => {
    stopPicking();
    if (!session) return;
    session.pending = null;
    if (session.windowOpen) await eda.sys_IFrame.showIFrame(WINDOW_ID);
    logRun('已取消选点。');
    notify('已取消选点。');
  });
}
