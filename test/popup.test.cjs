const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  children = [];
  style = {};
  attrs = new Map();
  listeners = {};
  textContent = '';
  scrollTop = 0;
  bounds = { left: 0, top: 0, width: 600, height: 260, bottom: 260 };
  capturedPointers = new Set();
  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node),1);
        node.parentElement=this;
      }
      this.children.push(node);
    }
  }
  replaceChildren() { this.children = []; this.scrollTop = 0; }
  get childElementCount() { return this.children.length; }
  getBoundingClientRect() { return this.bounds; }
  setPointerCapture(id) { this.capturedPointers.add(id); }
  hasPointerCapture(id) { return this.capturedPointers.has(id); }
  releasePointerCapture(id) { this.capturedPointers.delete(id); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  select() { this.selectedText = this.value; }
  checkValidity() { return true; }
}

test('popup selects routes, filters layers and exports an isolated debug log snapshot', async () => {
  const geometry = fs.readFileSync(path.join(__dirname,'../src/geometry.js'),'utf8');
  const {buildRoutePreview,sealBoard} = vm.runInNewContext(geometry + '\n({buildRoutePreview,sealBoard})');
  const board = sealBoard([[{x:-10,y:-10},{x:110,y:-10},{x:110,y:50},{x:-10,y:50},{x:-10,y:-10}]]);
  const layer1 = {id:1,name:'顶层',color:'#EF4444'};
  const layer2 = {id:2,name:'底层',color:'#3B82F6'};
  const edge = (x0,y0,x1,y1,layer) => ({kind:'track',path:[{x:x0,y:y0},{x:x1,y:y1}],layers:[layer],
    radius:5,length:Math.hypot(x1-x0,y1-y0)});
  const route = (length,edges) => ({length,edges});
  const a={label:'J1.1',net:'GND'};
  const s = {token:'fixture',pairs:[{start:a,end:a}],layers:[layer1,layer2],currentLayer:1,
    activeLayerRead:true,mode:'separate',group:0,selected:-1,visibleLayers:[1,2],display:'follow',colorMode:'layer',
    groups:[{routes:[route(100,[edge(0,0,50,0,1),edge(50,0,100,0,2)]),
      route(140,[edge(0,0,60,25,1),edge(60,25,100,0,1)])],label:'A→A'}]};
  const ids = new Map();
  const get = key => { if(!ids.has(key)) ids.set(key,new Element()); return ids.get(key); };
  const input = Object.assign(new Element(), {value:'separate',checked:true});
  const document = {body:new Element(),getElementById:get,querySelectorAll:()=>[input],createElement:()=>new Element(),
    createElementNS:(_,name)=>Object.assign(new Element(),{tag:name})};
  let receive, receiveDebug, lastRequest, file;
  const revoked = [];
  const URL = {createObjectURL:blob=>{file=blob;return 'blob:diagnostic';},revokeObjectURL:url=>revoked.push(url)};
  const window = new Element();
  window.eda = {sys_MessageBus:{subscribe:(topic,fn)=>{
    if(topic.endsWith('.state')) receive=fn;
    else if(topic.endsWith('.debugLog')) receiveDebug=fn;
  },publish:(topic,data)=>{
    const req=JSON.parse(data);
    lastRequest=req;
    if(req.type==='exportLog') {
      receiveDebug(JSON.stringify({token:req.token,text:'测试日志',filename:'return-path.log'}));
      return;
    }
    if(req.page!=null || req.selected>=50) return;
    if(req.type==='view') {
      Object.assign(s,req);
      if(req.diagramRoute!=null) s.selected=req.diagramRoute;
      if(req.display) s.visibleLayers=req.display==='current'?[1]:[1,2];
    }
    if(req.type==='style') {
      s.layerStyles ??= {};
      s.layerStyles[req.layer] ??= {};
      if(req.reset) delete s.layerStyles[req.layer];
      if(req.width) s.layerStyles[req.layer].width=req.width;
      if(req.color) {
        s.layerStyles[req.layer].color=req.color;
        s.colorMode='custom';
      }
    }
    if(req.type==='curveDensity') s.curveDensity=req.value;
    if(req.type==='workspaceWidth') s.workspaceWidth=req.value;
    s.activePreview = buildRoutePreview(s.groups[0].routes[Math.max(0,s.selected)], id=>s.visibleLayers.includes(id),
      s.curveDensity??2, board, new Map());
    const other=s.selected===1?0:1;
    s.inactivePreview = s.showAllRoutes ? buildRoutePreview(s.groups[0].routes[other],
      id=>s.visibleLayers.includes(id), s.curveDensity??2, board, new Map()) : undefined;
    for (const item of [...(s.inactivePreview?.paths || []),...(s.inactivePreview?.vias || [])]) item.routeIndex=other;
    receive(JSON.stringify(s));
  }}};
  const code = fs.readFileSync(path.join(__dirname,'../iframe/results.js'),'utf8');
  vm.runInNewContext(code,{window,document,URL,Blob});
  assert.equal(get('creatorWatermark').parentElement,document.body);
  assert.equal(get('configuration').hidden,false);
  receive(JSON.stringify({...s,progress:'第 1 / 1 对 A→A · 搜索覆铜绕行路线',taskActive:true}));
  assert.equal(get('calculationProgress').hidden,false);
  assert.equal(get('configuration').hidden,true);
  assert.equal(get('calculate').disabled,true);
  assert.match(get('progressStage').textContent,/搜索覆铜/);
  const beforeTutorial=lastRequest;
  get('usageTutorial').listeners.click();
  assert.equal(get('tutorialDialog').open,true);
  assert.equal(get('creatorWatermark').parentElement,get('tutorialDialog'));
  window.listeners.keydown({key:'Escape',preventDefault(){}});
  assert.equal(get('tutorialDialog').open,false);
  assert.equal(lastRequest,beforeTutorial);
  assert.equal(get('creatorWatermark').parentElement,document.body);
  get('usageTutorial').listeners.click();
  get('tutorialClose').listeners.click();
  assert.equal(get('tutorialDialog').open,false);
  assert.equal(get('exportDebugLog').disabled,false);
  get('exportDebugLog').listeners.click();
  assert.equal(lastRequest.type,'exportLog');
  assert.equal(get('debugLogDialog').open,true);
  assert.equal(get('creatorWatermark').parentElement,get('debugLogDialog'));
  assert.equal(get('debugLogDownload').getAttribute('download'),'return-path.log');
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer()).slice(0,3)),[239,187,191]);
  receiveDebug(JSON.stringify({token:'old-session',text:'stale',filename:'stale.log'}));
  get('debugLogSelect').listeners.click();
  assert.equal(get('debugLogText').selectedText,'测试日志');
  get('debugLogClose').listeners.click();
  assert.equal(get('creatorWatermark').parentElement,document.body);
  assert.equal(get('debugLogText').value,'');
  assert.deepEqual(revoked,['blob:diagnostic']);
  receive(JSON.stringify(s));
  assert.equal(get('calculationProgress').hidden,true);
  assert.equal(get('configuration').hidden,false);
  assert.equal(get('calculate').disabled,false);
  assert.deepEqual(get('routes').children.map(item=>item.children[1].textContent),['2.540 mm','3.556 mm']);
  const firstRow=get('routes').children[0], beforeUnit=lastRequest;
  get('routes').scrollTop=87;
  get('lengthUnit').listeners.click();
  assert.equal(get('lengthUnit').getAttribute('data-unit'),'mil');
  assert.deepEqual(get('routes').children.map(item=>item.children[1].textContent),['100.000 mil','140.000 mil']);
  assert.equal(get('routes').scrollTop,87);
  assert.equal(get('routes').children[0],firstRow);
  assert.match(get('detail').textContent,/50\.000 mil/);
  assert.equal(lastRequest,beforeUnit);
  receive(JSON.stringify(s));
  assert.equal(get('lengthUnit').getAttribute('data-unit'),'mil');
  get('lengthUnit').listeners.click();
  assert.equal(get('lengthUnit').getAttribute('data-unit'),'mm');
  assert.equal(get('routes').children[0].children[1].textContent,'2.540 mm');
  assert.equal(get('routes').scrollTop,87);
  const polylines=()=>get('drawing').children.filter(el=>el.tag==='polyline');
  const grayLines=()=>polylines().filter(el=>el.getAttribute('stroke')==='#858585');
  const strokes=()=>polylines().filter(el=>!grayLines().includes(el)).map(el=>el.getAttribute('stroke'));
  assert.ok(strokes().includes('#3B82F6'));
  assert.ok(polylines().filter(el=>el.getAttribute('stroke')!=='#858585').every(el=>el.getAttribute('stroke-width')==='3.5'));
  assert.equal(grayLines().length,0);
  assert.equal(get('routeVisibility').textContent,'显示全部路径');
  get('routeVisibility').listeners.click();
  assert.equal(get('routeVisibility').getAttribute('aria-pressed'),'true');
  assert.equal(get('routeVisibility').textContent,'仅显示选中路径');
  assert.ok(grayLines().length && grayLines().every(el=>el.getAttribute('stroke-width')==='0.8'));
  const list=get('routes'), second=list.children[1];
  list.scrollTop=110;
  second.listeners.click();
  assert.equal(list.scrollTop,110);
  assert.equal(list.children[1],second);
  assert.equal(get('routes').children[1].getAttribute('aria-pressed'),'true');
  assert.deepEqual(strokes(),['#EF4444']);
  assert.equal(grayLines().length,2);
  const drawing=get('drawing');
  const fit=drawing.getAttribute('viewBox');
  const cursor={clientX:300,clientY:180};
  let wheelPrevented=false;
  drawing.listeners.wheel({...cursor,deltaY:-120,preventDefault(){wheelPrevented=true;}});
  assert.equal(wheelPrevented,true);
  const zoom=drawing.getAttribute('viewBox');
  assert.ok(Number(zoom.split(' ')[2])<Number(fit.split(' ')[2]));
  const [x,y,w,h]=zoom.split(' ').map(Number);
  const scale=Math.min(600/w,260/h);
  drawing.listeners.click({clientX:300+(25-x-w/2)*scale,clientY:130+(0-y-h/2)*scale});
  assert.equal(lastRequest.diagramRoute,0);
  assert.equal(list.children[0].getAttribute('aria-pressed'),'true');
  assert.equal(drawing.getAttribute('viewBox'),zoom);
  get('resetDrawingZoom').listeners.click();
  assert.equal(drawing.getAttribute('viewBox'),fit);
  const [fitX,fitY,fitW,fitH]=fit.split(' ').map(Number);
  const fitScale=Math.min(600/fitW,260/fitH);
  let panPrevented=0;
  const pointer={pointerId:4,button:2,buttons:2,clientX:300,clientY:130,preventDefault(){panPrevented++;}};
  drawing.listeners.pointerdown({...pointer,button:0});
  assert.equal(drawing.hasPointerCapture(4),false);
  drawing.listeners.pointerdown(pointer);
  assert.equal(drawing.hasPointerCapture(4),true);
  drawing.listeners.pointermove({...pointer,clientX:360,clientY:160});
  const pan=drawing.getAttribute('viewBox');
  const [panX,panY,panW,panH]=pan.split(' ').map(Number);
  assert.ok(Math.abs(panX-(fitX-60/fitScale))<1e-9);
  assert.ok(Math.abs(panY-(fitY-30/fitScale))<1e-9);
  assert.equal(panW,fitW);
  assert.equal(panH,fitH);
  receive(JSON.stringify(s));
  assert.equal(drawing.getAttribute('viewBox'),pan);
  drawing.listeners.pointerup(pointer);
  assert.equal(drawing.hasPointerCapture(4),false);
  drawing.listeners.pointermove({...pointer,clientX:480});
  assert.equal(drawing.getAttribute('viewBox'),pan);
  drawing.listeners.pointerdown(pointer);
  window.listeners.blur();
  assert.equal(drawing.hasPointerCapture(4),false);
  drawing.listeners.contextmenu({preventDefault(){panPrevented++;}});
  assert.equal(panPrevented,4);
  get('resetDrawingZoom').listeners.click();
  assert.equal(drawing.getAttribute('viewBox'),fit);
  second.listeners.click();
  const activePoints=()=>polylines().find(el=>!grayLines().includes(el)).getAttribute('points').split(' ');
  const originalCount=activePoints().length;
  assert.ok(originalCount>3 && !activePoints().includes('60,-25'));
  assert.equal(activePoints()[0],'0,0');
  assert.equal(activePoints().at(-1),'100,0');
  assert.equal(get('curveDensity').value,'2');
  assert.equal(get('workspaceWidth').value,'8');
  get('workspaceWidth').value='12';
  get('workspaceWidth').listeners.change();
  assert.equal(s.workspaceWidth,12);
  get('curveDensity').value='4';
  get('curveDensity').listeners.change();
  assert.ok(activePoints().length>originalCount);
  assert.deepEqual(activePoints(),Array.from(s.activePreview.paths[0].points,q=>q.x+','+-q.y));
  assert.equal(get('routes').children[1].children[1].textContent,'3.556 mm');
  window.listeners.keydown({code:'KeyS',shiftKey:true,preventDefault(){}});
  assert.equal(get('display').value,'current');
  assert.ok(strokes().length && strokes().every(color=>color==='#EF4444'));
  get('color').value='mono';
  get('color').listeners.change();
  assert.ok(strokes().length && strokes().every(color=>color==='#20C9DB'));
  assert.equal(get('styleTitle').textContent,'2 层板 · 路径样式');
  get('styleColor').value='#FF00FF';
  get('styleColor').listeners.change();
  get('styleWidth').value='0.4';
  get('styleWidth').listeners.change();
  assert.equal(get('color').value,'custom');
  assert.ok(strokes().every(color=>color==='#FF00FF'));
  assert.ok(polylines().every(el=>el.getAttribute('stroke-width')===
    (el.getAttribute('stroke')==='#858585' ? '0.8' : '0.4')));
  get('styleReset').listeners.click();
  assert.ok(strokes().every(color=>color==='#EF4444'));
  get('routeVisibility').listeners.click();
  assert.equal(grayLines().length,0);
  assert.equal(get('routes').children[1].getAttribute('aria-pressed'),'true');
  receive(JSON.stringify({...s,routePage:{index:0,offset:0,count:'51',pages:'2',hasNext:true}}));
  assert.equal(get('nextRoutePage').disabled,false);
  get('nextRoutePage').listeners.click();
  assert.equal(lastRequest.page,1);
  assert.equal(get('previewLoading').hidden,false);
  receive(JSON.stringify({...s,routePage:{index:0,offset:0,count:'51',pages:'2',hasNext:true}}));
  assert.equal(get('previewLoading').hidden,false);
  receive(JSON.stringify({...s,selected:50,previewRequest:lastRequest.previewRequest,
    groups:[{...s.groups[0],routes:[s.groups[0].routes[1]]}],
    routePage:{index:1,offset:50,count:'51',pages:'2',hasNext:false}}));
  assert.equal(get('previewLoading').hidden,true);
  assert.equal(get('routePageStatus').textContent,'51 条 · 2 / 2 页');
  assert.equal(get('routes').children[0].children[0].textContent,'51 · 可行解');
  get('routes').children[0].listeners.click();
  assert.equal(lastRequest.selected,50);
  receive(JSON.stringify({...s,previewRequest:lastRequest.previewRequest,selected:50,
    groups:[{...s.groups[0],routes:[s.groups[0].routes[1]]}],
    routePage:{index:1,offset:50,count:'51',pages:'2',hasNext:false}}));
  get('previousRoutePage').listeners.click();
  assert.equal(lastRequest.page,0);
  get('exportDebugLog').listeners.click();
  window.listeners.pagehide();
  assert.equal(get('debugLogText').value,'');
  assert.deepEqual(revoked,['blob:diagnostic','blob:diagnostic']);
  assert.equal(lastRequest.type,'closed');
});

test('the top hint exposes cancellation in the frame, and from the host when keyboard access is available', () => {
  const code = fs.readFileSync(path.join(__dirname, '../iframe/hint.html'), 'utf8').match(/<script>([\s\S]+?)<\/script>/)[1];
  const nodes = Object.fromEntries(['message', 'progress', 'cancel'].map(id => [id, new Element()]));
  const window = new Element();
  window.parent = new Element();
  window.parent.innerWidth = 1440;
  const actions = [];
  let receive;
  window.eda = {sys_MessageBus: {
    subscribe: (_, fn) => { receive = fn; },
    publish: (_, raw) => { actions.push(JSON.parse(raw)); },
  }};
  vm.runInNewContext(code, {window, document: {getElementById: id => nodes[id]}});
  assert.deepEqual(actions, [{type:'hintReady', viewportWidth:1440}]);
  receive({token:'run', text:'选择起始点 A', calculating:false});
  assert.equal(nodes.message.textContent, '选择起始点 A');
  assert.equal(nodes.progress.hidden, true);
  window.parent.listeners.keydown({key:'s'});
  assert.equal(actions.length, 1);
  receive({token:'run', text:'读取同网络铜箔', calculating:true});
  assert.equal(nodes.progress.hidden, false);
  let prevented = 0;
  for (const target of [window.parent, window]) {
    target.listeners.keydown({key:'Escape', preventDefault() { prevented++; }});
  }
  nodes.cancel.listeners.click();
  assert.equal(prevented, 2);
  assert.deepEqual(actions.slice(1), Array.from({length:3}, () => ({type:'cancel', token:'run'})));
});
