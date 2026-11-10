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
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  get childElementCount() { return this.children.length; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  checkValidity() { return true; }
}

test('popup sorts display, focuses a route, filters layers with Shift+S, and switches palette', () => {
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
  const document = {getElementById:get,querySelectorAll:()=>[input],createElement:()=>new Element(),
    createElementNS:(_,name)=>Object.assign(new Element(),{tag:name})};
  let receive;
  const window = new Element();
  window.eda = {sys_MessageBus:{subscribe:(topic,fn)=>{receive=fn;},publish:(topic,data)=>{
    const req=JSON.parse(data);
    if(req.type==='view') {
      Object.assign(s,req);
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
    receive(JSON.stringify(s));
  }}};
  const code = fs.readFileSync(path.join(__dirname,'../iframe/results.js'),'utf8');
  vm.runInNewContext(code,{window,document});
  assert.equal(get('configuration').hidden,false);
  receive(JSON.stringify({...s,progress:'第 1 / 1 对 A→A · 搜索覆铜绕行路线'}));
  assert.equal(get('calculationProgress').hidden,false);
  assert.equal(get('configuration').hidden,true);
  assert.equal(get('calculate').disabled,true);
  assert.match(get('progressStage').textContent,/搜索覆铜/);
  receive(JSON.stringify(s));
  assert.equal(get('calculationProgress').hidden,true);
  assert.equal(get('configuration').hidden,false);
  assert.equal(get('calculate').disabled,false);
  assert.deepEqual(get('routes').children.map(item=>item.children[1].textContent),['2.540 mm','3.556 mm']);
  const polylines=()=>get('drawing').children.filter(el=>el.tag==='polyline');
  const grayLines=()=>polylines().filter(el=>el.getAttribute('stroke')==='#858585');
  const strokes=()=>polylines().filter(el=>!grayLines().includes(el)).map(el=>el.getAttribute('stroke'));
  assert.ok(strokes().includes('#3B82F6'));
  assert.ok(polylines().filter(el=>el.getAttribute('stroke')!=='#858585').every(el=>el.getAttribute('stroke-width')==='3.5'));
  assert.ok(grayLines().length && grayLines().every(el=>el.getAttribute('stroke-width')==='0.8'));
  get('routes').children[1].listeners.click();
  assert.equal(get('routes').children[1].getAttribute('aria-pressed'),'true');
  assert.deepEqual(strokes(),['#EF4444']);
  assert.equal(grayLines().length,2);
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
