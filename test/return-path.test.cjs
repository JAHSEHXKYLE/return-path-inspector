const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({ console, setTimeout: () => 0 });
const dir = path.join(__dirname, '..', 'src');
const version = require('../extension.json').version;
const code = 'const EXTENSION_VERSION = ' + JSON.stringify(version) + ';\n' + ['geometry.js', 'pcb.js', 'index.js'].map(name =>
  fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
vm.runInContext(code, context);
const api = vm.runInContext('({sealBoard, validateEnds, computeRoutes, routeSearch, combineRoutes, readPolygon, readBoard, readNet, readEndpoint, calculate, visibleLayer, readView, savePreview, clearStoredPreview, buildRoutePreview, copperLayers, readStyles, writeStyles, ringEdges, segmentIn, inCopper, readCopperDepths, validCopperDepths, estimateCopperDepths})', context);
const readTrack = vm.runInContext('readTrack', context);
const plain = value => JSON.parse(JSON.stringify(value));

const p = (x, y) => ({x, y});
const rect = (x, y, w, h) => [p(x,y),p(x+w,y),p(x+w,y+h),p(x,y+h),p(x,y)];
const board = () => api.sealBoard([rect(-10, -10, 120, 120)]);
const e = (id,x,y,layers=[1],net='GND') => ({id, p:p(x,y), net, layers, radius:0});
const t = (id,x,y,x2,y2,layer=1) => ({id,layer,points:[p(x,y),p(x2,y2)]});
const m = (tracks,anchors,planes=[]) => ({tracks,anchors,planes,warnings:[]});

function searchPasses(model, start, end, outline) {
  const passes = new Map();
  const search = api.routeSearch(model,start,end,outline,(event,data) => {
    if (event==='solver.enumeration') passes.set(data.direction,data);
  });
  let step;
  do { step=search.next(); } while (!step.done);
  return { ...step.value, passes };
}

function routingForks(first, last, layer=1) {
  const tracks=[];
  for (let i=first; i<last; i++) {
    const x=i*100;
    tracks.push(t('direct-'+i,x,0,x+100,0,layer),
      t('short-a-'+i,x,0,x+50,20,layer),t('short-b-'+i,x+50,20,x+100,0,layer));
  }
  return tracks;
}

test('bounds detailed diagnostic logs and reports discarded rows', () => {
  const record = vm.runInContext('debugEvent', context);
  const s = {debugLog:{lines:[],chars:0,dropped:0}};
  for(let i=0;i<1400;i++) record(s,'test.entry',{ index:i });
  assert.equal(s.debugLog.lines.length,1000);
  assert.equal(s.debugLog.dropped,400);
  for(let i=0;i<300;i++) record(s,'test.large',{ index:i, value:'中'.repeat(2500) });
  assert.ok(s.debugLog.chars<=192*1024);
  assert.ok(s.debugLog.dropped>400);
  assert.match(s.debugLog.lines.at(-1),/299.*截断/);
});

test('ranks two ordinary branches by physical route length', () => {
  const a=e('a',0,0), b=e('b',80,0);
  const result = api.computeRoutes(m([t('straight',0,0,80,0),t('up',0,0,0,40),
    t('across',0,40,80,40),t('down',80,40,80,0)], [a,b]),a,b,board());
  assert.deepEqual(plain(result.routes.map(route => route.length)), [80, 160]);
});

test('a copper arc keeps its physical length and uses denser preview segments', () => {
  const arc = {primitiveType:'Arc', primitiveId:'arc', layer:1, arcAngle:90,
    startX:20, startY:20, endX:80, endY:20};
  const track = readTrack(arc);
  const outlineArc = readTrack({...arc, layer:11});
  assert.equal(track.points.length - 1, 2 * (outlineArc.points.length - 1));
  const a=e('a',20,20), b=e('b',80,20);
  const {routes} = api.computeRoutes(m([track], [a,b]), a, b, board());
  const radius = 30 * Math.SQRT2;
  assert.ok(Math.abs(routes[0].length - radius * Math.PI / 2) < 1e-8);
  const preview = api.buildRoutePreview(routes[0], () => true, 2, board(), new Map());
  const points = preview.paths.flatMap(path => path.points);
  assert.equal(points.length, track.points.length);
  assert.ok(points.every(p => Math.abs(Math.hypot(p.x - 50, p.y - 50) - radius) < 1e-8));
  const fineTrack = readTrack(arc, 4);
  assert.equal(fineTrack.points.length - 1, 2 * (points.length - 1));
  const picked = {...a, id:arc.primitiveId, p:fineTrack.points[2], track:true};
  const coarseTrack = readTrack(arc, 1);
  const recalculated = api.computeRoutes(m([coarseTrack], [b]), picked, b, board());
  assert.ok(recalculated.routes[0].length > 0 && recalculated.routes[0].length < routes[0].length);
});

test('subdivides T junctions and accepts an endpoint on a trace centerline', () => {
  const a={...e('main',15,0),track:true}, b=e('b',30,40);
  const result = api.computeRoutes(m([t('main',0,0,90,0),t('branch',30,0,30,40)], [b]),a,b,board());
  assert.equal(result.routes[0].length,55);
});

test('requires a real via for cross-layer continuity', () => {
  const a=e('a',0,0), b=e('b',80,0,[2]), v=e('via',40,0,[1,2]);
  const tracks=[t('top',0,0,40,0),t('bottom',40,0,80,0,2)];
  assert.equal(api.computeRoutes(m(tracks,[a,b]),a,b,board()).routes.length,0);
  const route=api.computeRoutes(m(tracks,[a,b,v]),a,b,board()).routes[0];
  assert.equal(route.length,80);
  assert.deepEqual(plain(route.edges.find(edge => edge.kind === 'via').layers),[1,2]);
});

test('via depth contributes to length before route ranking', () => {
  const a=e('a',0,0), b=e('b',80,0);
  const vias=[e('v1',0,0,[1,2]),e('v2',80,0,[1,2])];
  const tracks=[t('up',0,0,0,40),t('across',0,40,80,40),t('down',80,40,80,0),t('bottom',0,0,80,0,2)];
  const model=m(tracks,[a,b,...vias]);
  assert.equal(api.computeRoutes(model,a,b,board()).routes[0].length,80);
  const {routes}=api.computeRoutes({...model,depthsMm:{1:0,2:2}},a,b,board());
  assert.equal(routes[0].length,160);
  assert.ok(Math.abs(routes[1].length*0.0254-(80*0.0254+4))<1e-9);
  assert.ok(routes[1].edges.filter(edge=>edge.kind==='via').every(edge=>edge.length*0.0254===2));
});

test('physical stack uses center depths and preserves the actual order of reordered inner layers', async () => {
  const list=[{layerId:5,thickness:0.2,zIndex:-1},{layerId:1,thickness:0.04,zIndex:0},
    {layerId:50,thickness:0.2,zIndex:1},{layerId:16,thickness:0.06,zIndex:2},
    {layerId:51,thickness:0.3,zIndex:3},{layerId:15,thickness:0.02,zIndex:4},
    {layerId:52,thickness:0.4,zIndex:5},{layerId:2,thickness:0.04,zIndex:6}];
  context.eda={pcb_Layer:{getCurrentPhysicalStackingConfiguration:async()=>({list:list.slice().reverse()})}};
  const depths=await api.readCopperDepths([1,15,16,2]);
  assert.ok(Math.abs(depths[16]-0.25)<1e-9);
  assert.ok(Math.abs(depths[15]-0.59)<1e-9);
  assert.ok(Math.abs(depths[2]-1.02)<1e-9);
  const a=e('a',0,0,[16]), b=e('b',80,0,[15]), via=e('via',40,0,[1,15,16,2]);
  const model=m([t('a-line',0,0,40,0,16),t('b-line',40,0,80,0,15)],[a,b,via]);
  const route=api.computeRoutes({...model,depthsMm:depths},a,b,board()).routes[0];
  assert.deepEqual(plain(route.edges.filter(edge=>edge.kind==='via').map(edge=>edge.layers)),[[16,15]]);
  assert.ok(Math.abs(route.length*0.0254-(80*0.0254+0.34))<1e-9);
  delete list[4].thickness;
  assert.equal(await api.readCopperDepths([1,15,16,2]),undefined);
  context.eda={pcb_Layer:{}};
  assert.equal(await api.readCopperDepths([1,2]),undefined);
  assert.equal(api.validCopperDepths({1:0,2:1.6},[1,2]),true);
  assert.equal(api.validCopperDepths({1:0,2:1.6,15:1.6},[1,15,2]),false);
});

test('four-layer board thickness estimate charges the outer-to-inner span rather than the full board thickness', () => {
  const ids=[1,15,16,2], depths=api.estimateCopperDepths(ids,1.6);
  assert.ok(depths[15]>0.24 && depths[15]<0.25);
  assert.ok(Math.abs(depths[15]-(1.6-depths[16]))<1e-9);
  assert.equal(depths[2],1.6);
  const a=e('a',0,0), b=e('b',80,0,[15]), via=e('via',40,0,ids);
  const model=m([t('top',0,0,40,0),t('inner',40,0,80,0,15)],[a,b,via]);
  const route=api.computeRoutes({...model,depthsMm:depths},a,b,board()).routes[0];
  assert.ok(Math.abs(route.length*0.0254-(80*0.0254+depths[15]))<1e-9);
});

test('refuses different and unassigned nets before board access', () => {
  const a=e('a',0,0), b=e('b',10,0,[1],'AGND');
  assert.throws(() => api.validateEnds(a,b,null),/网络不同/);
  assert.throws(() => api.validateEnds(a,{...b,net:''},null),/未分配/);
});

test('rejects an open, touching or self-crossing outline', () => {
  assert.throws(() => api.sealBoard([[p(0,0),p(10,0),p(10,10)]]),/未闭合/);
  assert.throws(() => api.sealBoard([[p(0,0),p(8,8),p(8,0),p(0,8),p(0,0)]]),/自相交/);
  assert.throws(() => api.sealBoard([rect(0,0,10,10),rect(10,0,10,10)]),/接触或相交/);
});

test('stitches segments and excludes two boards, nested holes and cutouts', () => {
  const r = rect(0,0,20,20);
  const contours=[...r.slice(1).map((q,i)=>[r[i],q]),rect(40,0,20,20),rect(4,4,4,4)];
  const b=api.sealBoard(contours,[rect(12,12,3,3).slice(0,-1)]);
  const a=e('a',2,2);
  assert.doesNotThrow(() => api.validateEnds(a,e('ok',10,10),b));
  for (const [x,y] of [[45,5],[5,5],[13,13],[0,2],[23,2]]) {
    assert.throws(() => api.validateEnds(a,e('bad',x,y),b),/同一个闭合板框/);
  }
});

test('rejects a geometrically short route that crosses a board slot', () => {
  const b=api.sealBoard([rect(-10,-10,100,70)],[rect(20,-2,30,8).slice(0,-1)]);
  const a=e('a',0,0), end=e('end',80,0);
  const result=api.computeRoutes(m([t('bad',0,0,80,0),t('up',0,0,0,15),
    t('middle',0,15,80,15),t('down',80,15,80,0)],[a,end]),a,end,b);
  assert.deepEqual(plain(result.routes.map(route => route.length)),[110]);
});

test('keeps both equal-length corridors around a clearance in filled copper', () => {
  const a=e('a',10,50), b=e('b',90,50);
  const plane={id:'pour',layer:1,rings:[rect(0,0,100,100).slice(0,-1),rect(40,35,20,30).slice(0,-1).reverse()]};
  const result=api.computeRoutes(m([],[a,b],[plane]),a,b,board());
  assert.equal(result.routes.length,2);
  assert.ok(result.routes.every(route => Math.abs(route.length - (2 * Math.hypot(30,15) + 20)) < 1e-6));
  assert.deepEqual(Array.from(result.routes, route => route.edges[0].path[1].y).sort((a,b)=>a-b), [35,65]);
});

test('finds both sides of a board slot even when the stored copper ring covers it', () => {
  const a=e('a',10,50), b=e('b',90,50);
  const outline=api.sealBoard([rect(-10,-10,120,120)],[rect(40,35,20,30)]);
  const ring=rect(0,0,100,100).slice(0,-1);
  const net=m([],[a,b],[{id:'pour',layer:1,rings:[ring]}]);
  for(const [start,end] of [[a,b],[b,a]]) {
    const result=api.computeRoutes(net,start,end,outline);
    assert.equal(result.incomplete,false);
    assert.equal(result.routes.length,2);
    const inside=api.validateEnds(start,end,outline);
    const edges=[...outline.edges,...api.ringEdges(ring)];
    assert.ok(result.routes.every(route=>route.edges.every(edge=>edge.path.slice(1).every((q,i)=>
      api.segmentIn(edge.path[i],q,edges,inside)))));
  }
});

test('collapses 4096 similar combinations before the maze and retains a distinct long detour', () => {
  const a=e('a',0,0), b=e('b',1200,0);
  const tracks=[];
  for(let i=0;i<12;i++) {
    const x=i*100;
    tracks.push(t('direct-'+i,x,0,x+100,0),
      t('near-a-'+i,x,0,x+50,0.5),t('near-b-'+i,x+50,0.5,x+100,0));
  }
  tracks.push(t('away-a',0,0,0,30),t('away-b',0,30,1200,30),t('away-c',1200,30,1200,0));
  const outline=api.sealBoard([rect(-5,-5,1210,40)]);
  const result=api.computeRoutes(m(tracks,[a,b]),a,b,outline);
  assert.deepEqual(Array.from(result.routes,route=>route.length),[1200,1260]);
  assert.equal(result.collapsedBranches,12);
  assert.equal(result.limited,false);
  assert.equal(result.incomplete,false);
});

test('clusters close stitching vias on both active pours, including across unused inner layers', () => {
  const a=e('a',10,10), b=e('b',30,10,[2]);
  const through=[1,15,16,2];
  const vias=[e('nearest',15,10,through),e('near',20,11,through),e('nearer-than-far',23,12,through),
    e('far',55,10,through)].map(via=>({...via,via:true}));
  const planes=[1,2].map(layer=>({id:'pour-'+layer,layer,rings:[rect(0,0,80,80).slice(0,-1)]}));
  const net={...m([],[a,b,...vias],planes),depthsMm:{1:0,15:0.1,16:0.2,2:0.3}};
  const result=api.computeRoutes(net,a,b,board());
  assert.equal(result.mergedVias,2);
  assert.equal(result.routes.length,2);
  assert.equal(result.limited,false);
  assert.ok(Math.abs(result.routes[0].length-20-0.3/0.0254)<1e-8);
  assert.deepEqual(Array.from(result.routes,route=>route.edges.find(edge=>edge.kind==='via').path[0].x),[15,55]);
  assert.equal(api.computeRoutes(net,b,a,board()).mergedVias,2);
});

test('merges equivalent vias across all four copper faces with equal short detours', () => {
  const through=[1,15,16,2];
  const a=e('a',12,40), b=e('b',75,40,[2]);
  const vias=[e('a-hole',32,40,through),e('b-hole',48,40,through)].map(via=>({...via,via:true}));
  const planes=through.map(layer=>({id:'pour-'+layer,layer,rings:[
    rect(0,0,85,80).slice(0,-1),rect(38,38,4,4).slice(0,-1).reverse(),
  ]}));
  const result=api.computeRoutes(m([],[a,b,...vias],planes),a,b,board());
  assert.equal(result.mergedVias,1);
  assert.ok(result.routes.length>=2);
  assert.ok(result.routes.every(route=>route.edges.filter(edge=>edge.kind==='via').every(edge=>edge.path[0].x===32)));
  const different=planes.map(plane=>plane.layer===15?{...plane,rings:[
    plane.rings[0],rect(38,34,4,12).slice(0,-1).reverse(),
  ]}:plane);
  assert.equal(api.computeRoutes(m([],[a,b,...vias],different),a,b,board()).mergedVias,0);
});

test('keeps the shortest representative of similar complete routes through different junctions', () => {
  const a=e('a',0,0), b=e('b',100,0);
  const tracks=[t('a-low',0,0,50,0),t('b-low',50,0,100,0),
    t('a-high',0,0,50,1),t('b-high',50,1,100,0),t('link',50,0,50,1)];
  const result=api.computeRoutes(m(tracks,[a,b]),a,b,board());
  assert.deepEqual(Array.from(result.routes,route=>route.length),[100]);
  assert.ok(result.mergedRoutes>0);
  assert.equal(result.limited,false);
});

test('deduplicates short jogs before a shared via without dropping a separate detour', () => {
  const a=e('a',0,20), b=e('b',850,20,[2]), via=e('shared',750,20,[1,2]);
  const tracks=[];
  for(let i=0;i<6;i++) {
    const x=i*125, y=20+(i+1)*0.13;
    tracks.push(t('a-low-'+i,x,20,x+60,20),t('b-low-'+i,x+60,20,x+125,20),
      t('a-high-'+i,x,20,x+60,y),t('b-high-'+i,x+60,y,x+125,20),t('cross-'+i,x+60,20,x+60,y));
  }
  tracks.push(t('finish',750,20,850,20,2),t('away-a',0,20,0,60),
    t('away-b',0,60,750,60),t('away-c',750,60,750,20));
  const outline=api.sealBoard([rect(-10,-10,870,100)]);
  const result=api.computeRoutes(m(tracks,[a,b,via]),a,b,outline);
  assert.deepEqual(Array.from(result.routes,route=>route.length),[850,930]);
  assert.ok(result.mergedRoutes>=50);
  assert.equal(result.limited,false);
});

test('preserves two near routes when an etched opening lies between them on the same copper layer', () => {
  const a=e('a',10,50), b=e('b',90,50);
  const plane={id:'pour',layer:1,rings:[
    rect(0,0,100,100).slice(0,-1),rect(45,49.6,10,0.8).slice(0,-1).reverse(),
  ]};
  const result=api.computeRoutes(m([],[a,b],[plane]),a,b,board());
  assert.equal(result.routes.length,2);
  assert.deepEqual(Array.from(result.routes,route=>route.edges[0].path[1].y).sort((a,b)=>a-b),[49.6,50.4]);
});

test('preserves two near parallel routes when a cutout lies between them', () => {
  const a=e('a',0,0), b=e('b',100,0);
  const tracks=[-0.65,0.65].flatMap((y,i)=>[
    t('start-'+i,0,0,10,y),t('middle-'+i,10,y,90,y),t('end-'+i,90,y,100,0),
  ]);
  const outline=api.sealBoard([rect(-5,-5,110,10)],[rect(48,-0.2,4,0.4)]);
  const result=api.computeRoutes(m(tracks,[a,b]),a,b,outline);
  assert.equal(result.routes.length,2);
  assert.equal(result.collapsedBranches,0);
  assert.equal(result.mergedRoutes,0);
});

test('collapses 12 pairs of stitching vias before searching the resulting 4096 combinations', () => {
  const a=e('a',10,20), b=e('b',1210,20);
  const outline=api.sealBoard([rect(-20,-5,1260,50)]);
  const planes=Array.from({length:13},(_,i)=>({
    id:'pour-'+i,layer:i%2+1,rings:[rect(i*100-10,0,120,40).slice(0,-1)],
  }));
  const vias=Array.from({length:12},(_,i)=>[96,104].map((x,j)=>
    e('via-'+i+'-'+j,x+i*100,20+j,[1,2]))).flat();
  const unclustered=api.computeRoutes(m([],[a,b,...vias],planes),a,b,outline);
  const clustered=api.computeRoutes(m([],[a,b,...vias.map(via=>({...via,via:true}))],planes),a,b,outline);
  assert.equal(unclustered.limited,false);
  assert.equal(unclustered.routes.length,4096);
  assert.equal(clustered.mergedVias,12);
  assert.equal(clustered.routes.length,1);
  assert.equal(clustered.routes[0].edges.filter(edge=>edge.kind==='via').length,12);
  assert.equal(clustered.limited,false);
});

test('keeps nearby vias distinct across a slot, a copper split or different attachment layers', () => {
  const a=e('a',10,10), b=e('b',45,10,[2]);
  const vias=[e('left',26,10,[1,2,15]),e('right',36,10,[1,2,15])].map(via=>({...via,via:true}));
  const top={id:'top',layer:1,rings:[rect(0,0,80,80).slice(0,-1)]};
  const bottom={...top,id:'bottom',layer:2};
  const cases=[
    [top,{...bottom,rings:[...bottom.rings,rect(30,6,2,8).slice(0,-1).reverse()]}],
    [top,{...bottom,rings:[rect(0,0,29,80).slice(0,-1),rect(33,0,47,80).slice(0,-1)]}],
    [top,bottom,{id:'inner',layer:15,rings:[rect(20,2,10,15).slice(0,-1)],
      },{id:'inner-contact',layer:15,rings:[rect(14,2,7,15).slice(0,-1)]}],
  ];
  for(const [index,planes] of cases.entries()) {
    const anchors=index===2?[a,b,...vias,e('inner-pad',18,10,[15])]:[a,b,...vias];
    const result=api.computeRoutes(m([],anchors,planes),a,b,board());
    assert.equal(result.mergedVias,0);
    assert.ok(result.routes.length);
  }
});

test('retains every combination of visibly distinct routing branches in length order', () => {
  const a=e('a',0,0), b=e('b',700,0);
  const tracks=[];
  for(let i=0;i<7;i++) {
    const x=i*100;
    tracks.push(t('direct-'+i,x,0,x+100,0),
      t('branch-a-'+i,x,0,x+50,20),t('branch-b-'+i,x+50,20,x+100,0));
  }
  const outline=api.sealBoard([rect(-5,-5,710,30)]);
  const result=api.computeRoutes(m(tracks,[a,b]),a,b,outline);
  assert.equal(result.routes.length,128);
  assert.ok(result.routes.every((route,i)=>i===0 || result.routes[i-1].length<=route.length));
});

test('probes an independent long branch among many shorter combinations', () => {
  const a=e('a',0,0), b=e('b',1000,0);
  const tracks=[];
  for(let i=0;i<10;i++) {
    const x=i*100;
    tracks.push(t('direct-'+i,x,0,x+100,0),
      t('branch-a-'+i,x,0,x+50,20),t('branch-b-'+i,x+50,20,x+100,0));
  }
  tracks.push(t('long-up',500,0,500,160),t('long-across',500,160,600,160),t('long-down',600,160,600,0));
  const outline=api.sealBoard([rect(-5,-5,1010,175)]);
  const result=api.computeRoutes(m(tracks,[a,b]),a,b,outline);
  assert.ok(result.routes.length>1);
  assert.ok(result.routes.some(route=>route.length===1320));
});

test('probes different departure directions and layers before the search reaches its budget', () => {
  const a=e('a',0,0,[1,2]), b=e('b',5000,0,[1,2]);
  const tracks=[];
  for(let i=0;i<50;i++) {
    const x=i*100;
    tracks.push(t('direct-'+i,x,0,x+100,0),
      t('upper-a-'+i,x,0,x+50,20),t('upper-b-'+i,x+50,20,x+100,0));
  }
  const detour=(id,layer,y)=>[t(id+'-start',0,0,0,y,layer),
    t(id+'-across',0,y,5000,y,layer),t(id+'-end',5000,y,5000,0,layer)];
  tracks.push(...detour('north',1,200),...detour('south',1,-400),...detour('bottom',2,-100));
  const outline=api.sealBoard([rect(-10,-420,5020,640)]);
  const result=api.computeRoutes(m(tracks,[a,b]),a,b,outline);
  assert.ok(result.limited);
  for (const [length,layer] of [[5400,1],[5800,1],[5200,2]]) {
    assert.ok(result.routes.some(route=>route.length===length && route.edges.every(edge=>edge.layers[0]===layer)),
      `missing ${length} mil detour on layer ${layer}`);
  }
});

test('reverse search adds a route leaving the target and keeps its geometry in A-to-B order', () => {
  const a=e('a',0,0), b=e('b',5000,0);
  const tracks=routingForks(0,50);
  tracks.push(t('long-out',200,0,200,-400),t('long-across',200,-400,5000,-400),
    t('long-in',5000,-400,5000,0));
  const outline=api.sealBoard([rect(-10,-420,5020,460)]);
  const { routes, passes }=searchPasses(m(tracks,[a,b]),a,b,outline);
  assert.deepEqual([...passes.keys()],['forward','reverse','same-layer']);
  assert.ok(passes.get('reverse').startSolutions>0);
  assert.ok(passes.get('reverse').duplicates>0);
  const detour=routes.find(route=>route.length===5800);
  assert.ok(detour?.edges.some(edge=>edge.path.some(p=>p.y===-400)));
  assert.deepEqual(plain(detour.edges[0].path[0]),a.p);
  assert.deepEqual(plain(detour.edges.at(-1).path.at(-1)),b.p);
});

test('same-layer search adds the long top-layer route among shorter options through vias', () => {
  const a=e('a',0,0), b=e('b',5000,0);
  const tracks=routingForks(1,49,2);
  tracks.push(t('lead',0,0,300,0),t('long-out',300,0,300,-800),
    t('long-across',300,-800,4700,-800),t('long-in',4700,-800,4700,0),t('tail',4700,0,5000,0));
  const vias=[100,200,4800,4900].map(x=>e('via-'+x,x,0,[1,2]));
  const outline=api.sealBoard([rect(-10,-820,5020,860)]);
  const model={...m(tracks,[a,b,...vias]),depthsMm:{1:0,2:1.6}};
  const { routes, passes }=searchPasses(model,a,b,outline);
  assert.equal(passes.get('same-layer').added,1);
  assert.ok(routes[0].edges.some(edge=>edge.kind==='via'));
  const planar=routes.filter(route=>route.edges.every(edge=>edge.kind!=='via'));
  assert.deepEqual(Array.from(planar,route=>route.length),[6600]);
  assert.ok(planar[0].edges.every(edge=>edge.layers[0]===1));
});

test('does not join two disconnected fills with the same name', () => {
  const a=e('a',10,10), b=e('b',90,10);
  const planes=[{id:'left',layer:1,rings:[rect(0,0,30,30).slice(0,-1)]},
    {id:'right',layer:1,rings:[rect(60,0,40,30).slice(0,-1)]}];
  assert.equal(api.computeRoutes(m([],[a,b],planes),a,b,board()).routes.length,0);
});

test('reads desktop board outline coordinates without flipping Y', () => {
  const [a,b,c,d,end]=api.readPolygon(['R',10,-20,50,30,0,0]);
  assert.deepEqual(plain([a,b,c,d,end]),[p(10,-20),p(60,-20),p(60,-50),p(10,-50),p(10,-20)]);
  const pts=api.readPolygon(['CIRCLE',5,-8,3]);
  assert.deepEqual(plain(pts[0]),plain(pts.at(-1)));
  assert.doesNotThrow(() => api.sealBoard([pts]));
  assert.throws(() => api.sealBoard([api.readPolygon([0,0,'L',5,0,5,5])]),/未闭合/);
  const rounded = api.readPolygon([10,0,'L',90,0,'ARC',-90,100,-10,'L',100,-90,
    'ARC',-90,90,-100,'L',10,-100,'ARC',-90,0,-90,'L',0,-10,'ARC',-90,10,0]);
  const outline = api.sealBoard([rounded]);
  assert.equal(outline.island(p(40,-40)),0);
  assert.equal(outline.island(p(40,40)),-1);
});

test('does not include a closed side loop returning to an already visited junction', () => {
  const a=e('a',0,0), b=e('b',80,0);
  const result=api.computeRoutes(m([t('left',0,0,40,0),t('right',40,0,80,0),t('up',40,0,40,20),
    t('over',40,20,55,20),t('back',55,20,40,0)], [a,b]),a,b,board());
  assert.deepEqual(Array.from(result.routes, route=>route.length),[80]);
});

test('combines explicit A and B pairs in nondecreasing total length', () => {
  const routes=lengths=>lengths.map(length=>({length,edges:[]}));
  const result=[...api.combineRoutes([{label:'A→A',routes:routes([10,15,25])},{label:'B→B',routes:routes([2,9])}])];
  assert.deepEqual(plain(result.map(route=>route.length)),[12,17,19,24,27,34]);
  assert.deepEqual(plain(result[0].parts.map(item=>item.label)),['A→A','B→B']);
  assert.equal([...api.combineRoutes([{routes:[]}])].length,0);
  const list=routes(Array.from({length:9},(_,i)=>i));
  const combinations=[...api.combineRoutes([{routes:list},{routes:list},{routes:list}])];
  assert.equal(combinations.length,729);
  assert.equal(new Set(combinations.map(route=>route.parts.map(part=>part.index).join(','))).size,729);
  assert.ok(combinations.every((route,i)=>i===0 || route.length>=combinations[i-1].length));
});

test('single-layer preview never shows segments belonging only to other layers', () => {
  const s={display:'current',currentLayer:1,layers:[{id:1,status:1},{id:2,status:1}]};
  assert.equal(api.visibleLayer(s,1),true);
  assert.equal(api.visibleLayer(s,2),false);
  s.display='follow';
  s.layers[1].status=2;
  assert.equal(api.visibleLayer(s,2),false);
});

test('wrong-net quick selection avoids all PCB geometry calls and writes', async () => {
  const doc={documentType:3,uuid:'demo',tabId:'one'};
  context.eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc}};
  await assert.rejects(api.calculate({doc,pairs:[{start:e('a',0,0),end:e('b',20,0,[1],'OTHER')}]},'separate',[0]),/网络不同/);
});

test('adapter reads MULTI fill as a board cutout and refuses a point inside it', async () => {
  let slotLayer;
  const outline={primitiveId:'outline',layer:11,polygon:{getSource:()=>['R',0,0,100,100,0,0]}};
  const polygon={getSource:()=>['R',10,-10,20,20,0,0]};
  context.eda={
    pcb_PrimitiveLine:{getAll:async()=>[]},pcb_PrimitiveArc:{getAll:async()=>[]},
    pcb_PrimitivePolyline:{getAll:async()=>[outline],get:async()=>[outline]},
    pcb_PrimitiveFill:{getAll:async layer=>{slotLayer=layer;return [{layer:12,complexPolygon:polygon}];}},
  };
  const b=await api.readBoard();
  assert.equal(slotLayer,12);
  assert.throws(()=>api.validateEnds(e('a',5,-5),e('b',15,-15),b),/槽孔/);
});

test('reads the real PCB4 outline when the bulk result pairs its ID with a preview path', async () => {
  const outline = {primitiveId:'board-outline',layer:11,polygon:{getSource:()=>['R',0,0,1000,1000,0,0]}};
  const corrupt = {...outline,polygon:{getSource:()=>[410,-170,'L',735,-660.95]}};
  const realOpen = {...outline,polygon:{getSource:()=>[0,0,'L',1000,0,1000,-1000,0,-1000]}};
  let byId = outline;
  context.eda = {
    pcb_PrimitiveLine:{getAll:async()=>[]}, pcb_PrimitiveArc:{getAll:async()=>[]},
    pcb_PrimitiveFill:{getAll:async()=>[]},
    pcb_PrimitivePolyline:{
      getAll:async()=>[corrupt],
      get:async ids=>{assert.deepEqual(Array.from(ids),[outline.primitiveId]);return [byId];},
    },
  };
  const start = e('GND1',290,-70), end = e('GND2',735,-705);
  const b = await api.readBoard();
  assert.doesNotThrow(()=>api.validateEnds(start,end,b));
  byId = realOpen;
  await assert.rejects(api.readBoard(),/板框未闭合/);
});

test('a Copper Region or Track hit resolves to the footprint pad at the cursor', async () => {
  const component={primitiveType:'Component',primitiveId:'conn',designator:'J1'};
  const pin={primitiveType:'ComponentPad',primitiveId:'pin',padNumber:'12',net:'GND',
    x:45,y:-35,layer:1,pad:['RECT',10,40],rotation:90};
  const around=[component];
  context.eda={
    pcb_Document:{getPrimitivesInRegion:async()=>around},
    pcb_PrimitiveComponent:{getAllPinsByPrimitiveId:async()=>[pin]},
  };
  for (const primitiveType of ['Copper Region','Track']) {
    const endpoint=await api.readEndpoint({primitiveType,net:'OTHER'},p(60,-35),[1,2],[1]);
    assert.equal(endpoint.id,'pin');
    assert.equal(endpoint.label,'J1.12');
    assert.equal(endpoint.net,'GND');
  }
  await assert.rejects(api.readEndpoint({primitiveType:'Copper Region'},p(45,-25),[1,2],[1]),/未找到被覆盖的可选焊盘/);
  await assert.rejects(api.readEndpoint({primitiveType:'Copper Region'},p(60,-35),[1,2],[2]),/未找到被覆盖的可选焊盘/);
});

test('complex poured copper can connect nearby terminals without using shortcuts outside copper', () => {
  const ring=Array.from({length:240},(_,i)=>p(50+45*Math.cos(i*Math.PI/120),50+45*Math.sin(i*Math.PI/120)));
  const a=e('a',20,50), end=e('via',80,50,[1,2]);
  const copper={id:'large',layer:1,rings:[ring]};
  const result=api.computeRoutes(m([],[a,end],[copper]),a,end,board());
  assert.equal(result.routes[0].length,60);
  assert.equal(result.incomplete,false);
});

test('large copper with many contacts finds a remote detour within the closed board', () => {
  const outer = Array.from({length: 3200}, (_, i) => {
    const angle = i * Math.PI / 1600;
    return p(50 + 48 * Math.cos(angle), 50 + 48 * Math.sin(angle));
  });
  const moat = rect(45,12,10,77).slice(0,-1).reverse();
  const copper = {id:'large',layer:1,rings:[outer,moat]};
  const a=e('a',35,50), b=e('b',65,50);
  const ports=Array.from({length:56},(_,i)=>e('port-'+i,36+i%7,42+Math.floor(i/7),[1,2]));
  const outline=board(), edges=copper.rings.flatMap(api.ringEdges);
  const inside=api.validateEnds(a,b,outline);
  const result=api.computeRoutes(m([],[a,b,...ports],[copper]),a,b,outline,6);
  assert.equal(result.incomplete,false);
  const route=result.routes[0];
  assert.ok(route.length>80 && route.length<105);
  assert.ok(route.edges.every(edge=>edge.path.slice(1).every((q,i)=>api.segmentIn(
    edge.path[i],q,[...edges,...outline.edges],x=>inside(x)&&api.inCopper(x,edges)))));
});

test('chamfer stops at the first copper boundary even when a larger chord would clear the hole', () => {
  const chamfer = vm.runInContext('chamferCorner', context);
  const shell = rect(-10,-10,70,70).slice(0,-1);
  const hole = rect(8,8,6,6).slice(0,-1).reverse();
  const edges = [shell,hole].flatMap(api.ringEdges);
  const contains = q => api.inCopper(q,edges);
  const a = p(0,40), corner = p(0,0), b = p(40,0);
  assert.ok(api.segmentIn(a,b,edges,contains));
  const [entry, exit] = chamfer(a,corner,b,edges,contains,{remaining:1000});
  assert.ok(entry.y > 15.8 && entry.y < 16);
  assert.ok(exit.x > 15.8 && exit.x < 16);
  assert.ok(api.segmentIn(entry,exit,edges,contains));
  assert.equal(api.segmentIn(p(0,17),p(17,0),edges,contains),false);
});

test('short middle segment collapses only below the ratio and when the entire shortcut stays legal', () => {
  const remove = vm.runInContext('removeShortMiddleSegments', context);
  const divisor = vm.runInContext('SHORT_MIDDLE_DIVISOR', context);
  const shell = rect(-10,-10,60,50).slice(0,-1);
  const points = span => [p(0,0),p(20,0),p(20,span),p(40,span)];
  const copper = api.ringEdges(shell);
  const hole = rect(18,0.8,1,1).slice(0,-1);
  const slotBoard = api.sealBoard([[...shell,shell[0]]],[hole]);
  const holedCopper = copper.concat(api.ringEdges(hole.slice().reverse()));
  const fixtures = [
    [points(9.4), copper, q=>api.inCopper(q,copper), true],
    [points(10), copper, q=>api.inCopper(q,copper), false],
    [points(3), holedCopper, q=>api.inCopper(q,holedCopper), false],
    [points(3), copper.concat(slotBoard.edges), q=>slotBoard.island(q)>=0, false],
  ];
  for (const [path,boundary,contains,expected] of fixtures) {
    const before = path.slice();
    assert.equal(remove(path,boundary,contains,{remaining:1000},divisor),expected);
    assert.deepEqual(path,expected ? [before[0],before[3]] : before);
  }
});

test('refines a mesh V detour without changing its copper layer, contacts, or via lengths', () => {
  const merge = vm.runInContext('mergeMeshRoute', context);
  const outline = api.sealBoard([rect(-2,-12,14,24)]);
  const copper = [rect(-1,-10,12,20).slice(0,-1),rect(4,-1,2,2).slice(0,-1).reverse()].flatMap(api.ringEdges);
  const boundary = copper.concat(outline.edges);
  const inside = q => outline.island(q)>=0;
  const contains = q => api.inCopper(q,copper);
  const points = [p(0,0),p(3,-8),p(8,-8),p(10,0)];
  const mesh = points.slice(1).map((q,i)=>({kind:'mesh',plane:'region',path:[points[i],q],layers:[2]}));
  const via = {kind:'via',path:[points.at(-1)],layers:[2,1],length:12};
  const regions = new Map([['region',{contains,boundary}]]);
  const base = merge([...mesh,via],regions,inside,{remaining:0});
  const refined = merge([...mesh,via],regions,inside,{remaining:1e6});
  const [section] = refined.edges;
  assert.ok(section.length < 10.5 && base.edges[0].length > 19);
  assert.equal(section.layers[0],2);
  assert.equal(section.path[0],points[0]);
  assert.equal(section.path.at(-1),points.at(-1));
  assert.equal(refined.edges[1],via);
  assert.ok(section.path.slice(1).every((q,i)=>api.segmentIn(section.path[i],q,boundary,x=>inside(x)&&contains(x))));
});

test('writes and clears only tracked non-copper preview lines', async () => {
  const doc={documentType:3,uuid:'demo-clear',tabId:'one',parentProjectUuid:'project'};
  const store=new Map(), layers=[{id:1,type:'SIGNAL',name:'TOP'}], lines=[];
  const deleted=[];
  context.eda={
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc},
    sys_Storage:{getExtensionUserConfig:key=>store.get(key),setExtensionUserConfig:async(key,value)=>{store.set(key,value);return true;}},
    pcb_Layer:{getAllLayers:async()=>layers,addCustomLayer:async()=>{layers.push({id:71,type:'CUSTOM'});return 71;},
      modifyLayer:async(id,props)=>{Object.assign(layers.find(x=>x.id===id),props);return true;}},
    pcb_MathPolygon:{createPolygon:source=>({getSource:()=>source})},
    pcb_PrimitivePolyline:{getAll:async(_,layer)=>lines.filter(item=>item.layer===layer),
      create:async(net,layer,polygon,width)=>{const item={net,layer,width,primitiveId:'own-'+lines.length};lines.push(item);return item;},
      delete:async ids=>{deleted.push(...ids);for(const id of ids)lines.splice(lines.findIndex(x=>x.primitiveId===id),1);return true;}},
  };
  assert.equal(await api.savePreview(doc,{paths:[{layer:1,points:[p(1,1),p(5,2),p(10,1)]}],vias:[]},8),71);
  assert.equal(lines[0].width,8);
  lines.push({net:'',layer:71,primitiveId:'user-line'});
  assert.equal(await api.clearStoredPreview(doc),1);
  assert.deepEqual(deleted,['own-0']);
  assert.equal(lines[0].primitiveId,'user-line');
});

test('shared preview rounds a copper corner only when its new segments stay inside the same copper', () => {
  const outline = board();
  const shell = rect(0,0,80,80).slice(0,-1);
  const hole = rect(20,20,30,30).slice(0,-1).reverse();
  const path = [p(20,45),p(20,20),p(45,20)];
  const route = {edges:[{kind:'plane',plane:'GND',layers:[1],path}]};
  const preview = rings => {
    const edges = rings.flatMap(api.ringEdges);
    const regions = new Map([['GND',{contains:q=>api.inCopper(q,edges),boundary:edges.concat(outline.edges)}]]);
    return api.buildRoutePreview(route,()=>true,2,outline,regions).paths[0].points;
  };
  const rounded = preview([shell]);
  assert.ok(rounded.length > path.length);
  assert.deepEqual(plain([rounded[0],rounded.at(-1)]),[path[0],path.at(-1)]);
  assert.deepEqual(plain(preview([shell,hole])),path);
});

test('EDA 4.1 generated copper connects rotated rectangular pads touching it without tracks', async () => {
  const pad = (id, x, y) => ({primitiveType:'Pad',primitiveId:id,net:'GND',x,y,layer:1,rotation:90,pad:['RECT',40,10,0]});
  let pads = [pad('a',500,-540),pad('b',640,-540)];
  const border = {primitiveId:'pour',net:'GND',layer:1,pourFillMethod:'solid'};
  const shape = {getSource:()=>[48,-56,'L',64,-56,64,-58,48,-58,48,-56]};
  const nativePour = {pourPrimitiveId:'pour',pourFills:[{fill:true,path:{toPolygon:()=>[shape]}}]};
  context.eda = {
    pcb_Net:{getAllPrimitivesByNet:async()=>[]},
    pcb_PrimitiveLine:{getAll:async()=>[]}, pcb_PrimitiveArc:{getAll:async()=>[]},
    pcb_PrimitiveVia:{getAll:async()=>[]},
    pcb_PrimitivePad:{get:async id=>pads.find(pad=>pad.primitiveId===id),getAll:async()=>pads},
    pcb_PrimitivePour:{getAll:async()=>[border]}, pcb_PrimitivePoured:{getAll:async()=>[nativePour]},
    pcb_PrimitiveFill:{getAll:async()=>[]},
  };
  const solve = async () => {
    const [a,b] = await Promise.all(pads.map(pad=>api.readEndpoint(pad,undefined,[1,2])));
    const model = await api.readNet('GND',[1,2],[a,b]);
    assert.deepEqual(plain(model.planes[0].rings[0][0]),p(480,-560));
    return api.computeRoutes(model,a,b,api.sealBoard([rect(400,-640,300,180)]));
  };
  const result = await solve();
  assert.equal(result.routes[0].length,180);
  assert.deepEqual(plain(result.routes[0].edges.map(edge=>edge.kind)),['pad','plane','pad']);
  pads = [pads[0],pad('b',640,-539.7)];
  assert.equal((await solve()).routes.length,0);
});

test('EDA 4.1 generated thermal spokes bridge pads to a solid pour only on their own layer and with real contact', async () => {
  const a={...e('a',10,50),radius:2}, b={...e('b',90,50),radius:2};
  const border={primitiveId:'gnd-pour',net:'GND',layer:1,pourFillMethod:'solid'};
  const polygon=source=>({toPolygon:()=>[{getSource:()=>source}]});
  const filled={fill:true,path:polygon([2,4,'L',8,4,8,6,2,6,2,4])};
  const spokeA={fill:false,lineWidth:0.2,path:polygon([1,5,'L',1.95,5])};
  const spokeB={fill:false,lineWidth:0.2,path:polygon([9,5,'L',8.05,5])};
  const native={pourPrimitiveId:border.primitiveId,pourFills:[filled,spokeA,spokeB]};
  const empty={getAll:async()=>[]};
  context.eda={pcb_Net:{getAllPrimitivesByNet:async()=>[]},pcb_PrimitiveLine:empty,pcb_PrimitiveArc:empty,
    pcb_PrimitiveVia:empty,pcb_PrimitivePad:empty,pcb_PrimitiveFill:empty,
    pcb_PrimitivePour:{getAll:async()=>[border]},pcb_PrimitivePoured:{getAll:async()=>[native]}};
  const solve=async()=>api.computeRoutes(await api.readNet('GND',[1,2],[a,b]),a,b,board(),6);
  const model=await api.readNet('GND',[1,2],[a,b]);
  assert.deepEqual(plain(model.tracks.map(track=>[track.layer,track.width,track.points])),[
    [1,2,[p(10,50),p(19.5,50)]],[1,2,[p(90,50),p(80.5,50)]],
  ]);
  assert.equal((await solve()).routes[0].length,80);
  spokeB.path=polygon([9,5,'L',8.2,5]);
  assert.equal((await solve()).routes.length,0);
  spokeB.path=polygon([9,5,'L',8.05,5]);
  border.layer=2;
  assert.equal((await solve()).routes.length,0);
});

test('detects only enabled copper layers and restores independently saved colors and widths', async () => {
  const layers = api.copperLayers([
    {id:1,type:'SIGNAL',layerStatus:1}, {id:2,type:'SIGNAL',layerStatus:1},
    {id:15,type:'PLANE',layerStatus:2}, {id:16,type:'SIGNAL',layerStatus:1},
    {id:17,type:'SIGNAL',layerStatus:0}, {id:71,type:'CUSTOM',layerStatus:1},
  ]);
  assert.deepEqual(plain(layers.map(layer=>layer.id)),[1,15,16,2]);
  const storage = new Map();
  context.eda = {sys_Storage:{
    getExtensionUserConfig:key=>storage.get(key),
    setExtensionUserConfig:(key,data)=>{storage.set(key,data);return true;},
  }};
  const doc = {uuid:'4-layer-board',parentProjectUuid:'project'};
  await api.writeStyles({doc,colorMode:'custom',curveDensity:4,workspaceWidth:12,layerStyles:{1:{color:'#FF00FF',width:0.4},15:{color:'#08FF22',width:1.1}}});
  const session = {doc,layers,colorMode:'layer',layerStyles:{}};
  await api.readStyles(session);
  assert.equal(session.colorMode,'custom');
  assert.equal(session.curveDensity,4);
  assert.equal(session.workspaceWidth,12);
  assert.deepEqual(plain(session.layerStyles),{1:{color:'#FF00FF',width:0.4},15:{color:'#08FF22',width:1.1}});
});

test('supports native Hide layer state even when the current layer API is a stub', async () => {
  const doc={documentType:3,uuid:'mock-view',tabId:'board'};
  const state={doc,display:'follow',layers:[]};
  const layers=[{id:1,name:'顶层',type:'SIGNAL',layerStatus:2,color:'#FF0000'},
    {id:2,name:'底层',type:'SIGNAL',layerStatus:1,color:'#0000FF'}];
  context.eda={
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc},
    pcb_Layer:{getAllLayers:async()=>layers,getCurrentLayer:()=>undefined},
    pcb_Document:{getCurrentFilterConfiguration:async()=>({TRACK:true})},
  };
  assert.equal(await api.readView(state),true);
  assert.equal(state.currentLayer,2);
  assert.equal(api.visibleLayer(state,1),false);
  assert.equal(api.visibleLayer(state,2),true);
  state.display='current';
  state.manualLayer=1;
  await api.readView(state);
  assert.equal(api.visibleLayer(state,1),true);
  assert.equal(api.visibleLayer(state,2),false);
});

test('uses raw net-query parent IDs to read normalized component pads', async () => {
  const fillPath={getSource:()=>['R',0,0,80,40,0,0]};
  const fill={layer:1,net:'GND',primitiveType:'Fill',primitiveId:'solid',fillMode:0,complexPolygon:fillPath};
  const compPad={primitiveType:'ComponentPad',primitiveId:'pad1',net:'GND',x:10,y:-15,layer:1,pad:['RECT',4,8]};
  context.eda={
    pcb_Net:{getAllPrimitivesByNet:async()=>[{parentId:'comp1',pcbItemPrimitiveType:'Pad'}]},
    pcb_PrimitiveComponent:{getAllPinsByPrimitiveId:async id=>id==='comp1'?[compPad]:[]},
    pcb_PrimitiveLine:{getAll:async()=>[]},pcb_PrimitiveArc:{getAll:async()=>[]},
    pcb_PrimitiveVia:{getAll:async()=>[]},pcb_PrimitivePad:{getAll:async()=>[]},
    pcb_PrimitivePour:{getAll:async()=>[]},pcb_PrimitiveFill:{getAll:async()=>[fill]},
  };
  const model=await api.readNet('GND',[1],[]);
  assert.equal(model.anchors[0].id,'pad1');
  assert.equal(model.anchors[0].radius,2);
  assert.equal(model.planes[0].id,'solid');
});

test('menu flow picks a plated multilayer connector pad and via, logs results, and clears the preview', async () => {
  const doc={documentType:3,uuid:'integration-fixture',tabId:'one',parentProjectUuid:'proj'};
  let selected, custom, results, panel, receive, cancelOnStage, cancelledSearch, cancelledSession, reportPreviewAlias=false;
  let markerSupported=true, markers=[], markerWidth, markerWidths=[];
  const events=[], logs=[], exportedLogs=[], storage=new Map(), drawn=new Map(), openWindows=new Map();
  let viewportWidth=1440, previewSerial=0, includeAlternatives=false, netReads=0;
  const a={primitiveType:'ComponentPad',primitiveId:'a',net:'GND',x:10,y:-10,layer:12,
    metallization:true,padNumber:'1',pad:['RECT',4,4]};
  const b={primitiveType:'Via',primitiveId:'b',net:'GND',x:70,y:-10,viaType:0,diameter:4};
  const rejected={...b,primitiveId:'c',viaType:1};
  const wire={primitiveType:'Line',primitiveId:'wire',net:'GND',layer:1,startX:10,startY:-10,endX:70,endY:-10};
  const lowerBranch=[
    {...wire,primitiveId:'lower-a',layer:2,endX:40,endY:-9.8},
    {...wire,primitiveId:'lower-b',layer:2,startX:40,startY:-9.8},
  ];
  const alternatives=Array.from({length:6},(_,i)=>{
    const x=10+i*10;
    return [
      {...wire,primitiveId:'detour-a-'+i,startX:x,endX:x+5,endY:-8},
      {...wire,primitiveId:'detour-b-'+i,startX:x+5,startY:-8,endX:x+10},
    ];
  }).flat();
  const markerLayer={id:71,name:'',type:'CUSTOM',layerStatus:1};
  const eda={
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc},
    dmt_EditorControl:{
      generateIndicatorMarkers:async (list, color, width)=>{
        if (!markerSupported) return false;
        markers.push(...list);
        markerWidth=width;
        markerWidths.push(width);
        return true;
      },
      removeIndicatorMarkers:async()=>{markers=[];markerWidths=[];return true;},
    },
    pcb_Layer:{
      getAllLayers:async()=>[{id:1,name:'Top',type:'SIGNAL',layerStatus:1,color:'#FF4040'},
        {id:2,name:'Bottom',type:'SIGNAL',layerStatus:1,color:'#4060FF'}, ...(custom?[markerLayer]:[])],
      getCurrentLayer:()=>undefined,
      addCustomLayer:async()=>{custom=true;return 71;},
      modifyLayer:async(_,fields)=>{Object.assign(markerLayer,fields);return true;},
      setLayerInvisible:async()=>{markerLayer.layerStatus=2;return true;},
      setLayerVisible:async()=>{markerLayer.layerStatus=1;return true;},
    },
    pcb_Document:{getCurrentFilterConfiguration:async()=>({}),getPrimitiveAtPoint:async()=>[]},
    pcb_SelectControl:{clearSelected:async()=>true,getCurrentMousePosition:async()=>p(10,-10)},
    pcb_Event:{isEventListenerAlreadyExist:()=>Boolean(selected),removeEventListener:()=>{selected=null;return true;},
      addMouseEventListener:(_,type,fn)=>{assert.equal(type,'selected');selected=fn;}},
    pcb_Net:{getAllPrimitivesByNet:async()=>[]},
    pcb_PrimitiveLine:{getAll:async net=>{
      if(net!=='GND') return [];
      netReads++;
      return [...lowerBranch,wire,...(includeAlternatives?alternatives:[])];
    }},
    pcb_PrimitiveArc:{getAll:async()=>[]},pcb_PrimitiveVia:{getAll:async()=>[b],get:async id=>id==='c'?rejected:b},
    pcb_MathPolygon:{createPolygon:source=>({getSource:()=>source})},
    pcb_PrimitivePolyline:{
      get:async ids=>ids.flatMap(id=>id==='outline'
        ? [{layer:11,primitiveId:id,polygon:{getSource:()=>['R',0,0,100,100,0,0]}}]
        : drawn.has(id) ? [drawn.get(id)] : []),
      getAll:async(_,layer)=>layer===71?[...drawn.values()]:[
        {layer:11,primitiveId:'outline',polygon:{getSource:()=>['R',0,0,100,100,0,0]}},
        ...[...drawn.values()].map(item=>({...item,layer:11,
          primitiveId:reportPreviewAlias?'outline-query-alias':item.primitiveId})),
      ],
      create:async(net,layer,polygon,width)=>{
        assert.equal(polygon.getSource()[2],'L');
        const item={net,layer,polygon,width,primitiveId:'preview-line-'+ ++previewSerial};
        drawn.set(item.primitiveId,item);
        return item;
      },
      delete:async ids=>{for(const id of ids)drawn.delete(id);return true;}},
    pcb_PrimitiveFill:{getAll:async()=>[]},pcb_PrimitivePour:{getAll:async()=>[]},
    pcb_PrimitivePad:{getAll:async()=>[]},
    pcb_PrimitiveComponent:{getAllPinsByPrimitiveId:async id=>id==='J1-id'?[a]:[]},
    sys_MessageBus:{subscribe:(_,callback)=>{receive=callback;},publish:(topic,data)=>{
      const payload=JSON.parse(data);
      if (topic.endsWith('.state')) results=payload;
      else if (topic.endsWith('.debugLog')) exportedLogs.push(payload);
      else {
        events.push(payload.text);
        if (cancelOnStage && payload.text.includes(cancelOnStage)) {
          cancelOnStage=undefined;
          cancelledSession=instance.menu.currentSession();
          cancelledSearch=cancelledSession.activeSearch;
          receive(JSON.stringify({type:'exportLog',token:payload.token}));
          receive(JSON.stringify({type:'cancel',token:payload.token}));
        }
      }
    }},
    sys_IFrame:{openIFrame:async(path,width,height,id,options)=>{
      assert.ok(['/iframe/hint.html','/iframe/index.html'].includes(path));
      openWindows.set(id,{width,height,...options});
      if (path === '/iframe/hint.html') receive(JSON.stringify({type:'hintReady', viewportWidth}));
      return true;
    },showIFrame:async()=>true, closeIFrame:async id=>{
      openWindows.get(id)?.onBeforeCloseCallFn?.();
      openWindows.delete(id);
      return true;
    }},
    sys_Storage:{getExtensionUserConfig:key=>storage.get(key),setExtensionUserConfig:async(key,value)=>{storage.set(key,value);return true;}},
    sys_ToastMessage:{showMessage:text=>events.push(text)},
    sys_Dialog:{showInformationMessage:message=>{throw new Error(message);}},
    sys_Log:{add:(message,type)=>logs.push({message,type})},
    sys_PanelControl:{openBottomPanel:tab=>{panel=tab;}},
  };
  const wrapped = 'var menu=(() => { if (eda.testRuntime) return eda.testRuntime;\n' + code +
    '\nreturn (eda.testRuntime={checkReturnPath,clearReturnPaths,showRunLog,drain:()=>queue,currentSession:()=>session});})();';
  const instance=vm.createContext({eda,setTimeout:(fn, delay)=>delay === 32 ? queueMicrotask(fn) : 0, clearTimeout:()=>{}});
  vm.runInContext(wrapped,instance);
  await instance.menu.showRunLog();
  assert.equal(panel,'log');
  await instance.menu.checkReturnPath();
  const hint=openWindows.get('return-path-task-hint');
  assert.equal(hint.title,'回流路径检查 v'+version);
  assert.equal(hint.width,680);
  assert.equal(hint.height,38);
  assert.equal(hint.x,380);
  assert.equal(hint.y,96);
  selected('selected',[{primitiveType:'Via',primitiveId:'c',net:'GND'}]);
  await instance.menu.drain();
  assert.ok(logs.some(entry=>entry.type==='error' && entry.message.includes('盲埋孔')));
  selected('selected',[{primitiveType:'Component',primitiveId:'J1-id',designator:'J1'}]);
  await instance.menu.drain();
  assert.ok(events.some(text=>text.includes('请单击流入点')));
  selected('selected',[{primitiveType:'Via',primitiveId:'b',net:'GND'}]);
  await instance.menu.drain();
  assert.equal(results.groups[0].routes.length,2);
  assert.equal(results.groups[0].routes[0].length,60);
  assert.ok(results.groups[0].routes[1].edges.every(edge=>edge.layers[0]===2));
  assert.deepEqual(results.groups[0].start.layers,[1,2]);
  assert.deepEqual(results.groups[0].end.layers,[1,2]);
  assert.ok(logs.some(entry=>entry.message.includes('J1.1') && entry.message.includes('Top / Bottom')));
  assert.ok(logs.some(entry=>entry.message.includes('可行解 · 长度 1.524 mm')));
  assert.ok(logs.every(entry=>entry.message.startsWith('[回流路径] ')));
  assert.equal(results.previewLayer,71);
  assert.equal(openWindows.get('return-path-results').title,'回流路径检查 v'+version);
  assert.equal(openWindows.get('return-path-results').minimizeButton,true);
  assert.equal(openWindows.get('return-path-results').minimizeStyle,'collapsed');
  assert.equal(drawn.size,1);
  assert.equal(markers.length,1);
  assert.equal(markerWidth,8);
  assert.equal([...drawn.values()][0].width,8);
  assert.ok(!openWindows.has('return-path-task-hint'));
  const updateView=async fields=>{
    receive(JSON.stringify({type:'view',token:results.token,...fields}));
    await instance.menu.drain();
  };
  await updateView({showAllRoutes:true});
  assert.equal(results.showAllRoutes,true);
  assert.equal(results.inactivePreview.paths[0].layer,2);
  assert.equal(results.inactivePreview.paths[0].routeIndex,1);
  assert.deepEqual(markerWidths,[0.8,8]);
  assert.deepEqual([...drawn.values()].map(item=>item.width),[0.8,8]);
  await updateView({selected:1});
  assert.equal(results.activePreview.paths[0].layer,2);
  assert.equal(results.inactivePreview.paths[0].layer,1);
  await updateView({showAllRoutes:false,selected:0});
  assert.equal(results.inactivePreview,undefined);
  assert.equal(drawn.size,1);
  const recalculate=async()=>{
    receive(JSON.stringify({type:'calculate',token:results.token,mode:'separate',mapping:[0]}));
    await instance.menu.drain();
    assert.equal(results.groups[0].routes[0].length,60);
    assert.equal(results.previewLayer,71);
    assert.equal(drawn.size,1);
  };
  await recalculate();
  receive(JSON.stringify({type:'curveDensity',token:results.token,value:4}));
  await instance.menu.drain();
  assert.equal(results.curveDensity,4);
  assert.ok(logs.some(entry=>entry.message.includes('重新计算前已清除 1 条旧预览线')));
  assert.ok(!logs.some(entry=>entry.message.includes('首次板框校验失败')));
  receive(JSON.stringify({type:'calculate',token:results.token,mode:'joint',mapping:[0]}));
  await instance.menu.drain();
  const lengths=results.joint.routes.map(route=>route.length);
  assert.deepEqual(lengths.map(length=>(length*0.0254).toFixed(3)),['1.524','1.524']);
  assert.equal(lengths[0],60);
  assert.ok(lengths[1]>lengths[0]);
  assert.equal(drawn.size,1);
  assert.equal(markers.length,1);
  receive(JSON.stringify({type:'view',token:results.token,selected:1}));
  await instance.menu.drain();
  const path = results.activePreview.paths[0].points;
  assert.equal(results.activePreview.paths[0].layer,2);
  assert.deepEqual(markers.map(m=>[m.startX,m.startY,m.endX,m.endY]),
    path.slice(1).map((q,i)=>[path[i].x,path[i].y,q.x,q.y]));
  assert.equal(drawn.size,1);
  assert.deepEqual(plain([...drawn.values()][0].polygon.getSource()),
    [path[0].x,path[0].y,'L',...path.slice(1).flatMap(q=>[q.x,q.y])]);
  receive(JSON.stringify({type:'workspaceWidth',token:results.token,value:12}));
  await instance.menu.drain();
  assert.equal(markerWidth,12);
  assert.equal([...drawn.values()][0].width,12);
  markerSupported=false;
  receive(JSON.stringify({type:'view',token:results.token,selected:0}));
  await instance.menu.drain();
  assert.equal(markers.length,0);
  assert.equal(drawn.size,1);
  assert.equal(markerLayer.layerStatus,1);
  assert.deepEqual(plain([...drawn.values()][0].polygon.getSource()),[10,-10,'L',70,-10]);
  markerSupported=true;
  await recalculate();
  reportPreviewAlias=true;
  await recalculate();
  assert.ok(logs.some(entry=>entry.message.includes('首次板框校验失败') && entry.message.includes('无法按图元 ID 读取板框折线')));
  assert.ok(logs.some(entry=>entry.message.includes('已清除 1 条旧预览线，正在重新读取板框')));
  reportPreviewAlias=false;
  includeAlternatives=true;
  await recalculate();
  assert.equal(results.routePage.count,'65');
  assert.equal(results.groups[0].routes.length,50);
  const reads=netReads;
  await updateView({showAllRoutes:true});
  assert.ok(results.inactivePreview.paths.some(path=>path.routeIndex===64));
  await updateView({diagramRoute:64,previewRequest:17});
  assert.equal(results.previewRequest,17);
  assert.equal(results.routePage.offset,50);
  assert.equal(results.routePage.hasNext,false);
  assert.equal(results.groups[0].routes.length,15);
  assert.equal(results.selected,64);
  assert.ok(results.activePreview.paths[0].points.some(point=>point.y>-9));
  assert.equal(netReads,reads);
  await updateView({page:0,showAllRoutes:false});
  assert.equal(results.selected,0);
  receive(JSON.stringify({type:'calculate',token:results.token,mode:'joint',mapping:[0]}));
  await instance.menu.drain();
  assert.equal(results.routePage.count,'65');
  assert.equal(results.joint.routes.length,50);
  await updateView({page:1});
  assert.equal(results.joint.routes.length,15);
  assert.equal(results.joint.routes.at(-1).parts[0].index,65);
  assert.equal(results.groups[0].routes.length,0);
  const initial=instance.menu;
  vm.runInContext(wrapped,instance);
  assert.equal(initial,instance.menu);
  await instance.menu.clearReturnPaths();
  assert.equal(drawn.size,0);
  assert.equal(markers.length,0);
  assert.equal(results.groups.length,0);
  assert.ok(logs.some(entry=>entry.message.includes('已清除 1 条预览线')));
  const firstSession=instance.menu.currentSession();
  receive(JSON.stringify({type:'exportLog',token:results.token}));
  const diagnostic=exportedLogs.at(-1);
  assert.match(diagnostic.filename,/\.log$/);
  for(const tag of ['session.start','selection.endpoint','analysis.board','analysis.stackup','pcb.primitives',
    'analysis.model','solver.graph','solver.enumeration','preview.render','ui.action','log.export']) {
    assert.ok(diagnostic.text.includes(tag),tag);
  }
  assert.match(diagnostic.text,/solver\.enumeration.*"algorithm":"weighted-maze".*"frontierPeak":/);
  await eda.sys_IFrame.closeIFrame('return-path-results');
  await instance.menu.drain();
  assert.equal(firstSession.debugLog,undefined);
  receive(JSON.stringify({type:'exportLog',token:results.token}));
  assert.equal(exportedLogs.length,1);
  viewportWidth=620;
  await instance.menu.checkReturnPath();
  const narrowHint=openWindows.get('return-path-task-hint');
  assert.equal(narrowHint.width,588);
  assert.equal(narrowHint.x,16);
  selected('selected',[{primitiveType:'Component',primitiveId:'J1-id',designator:'J1'}]);
  await instance.menu.drain();
  cancelOnStage='搜索连通路径';
  selected('selected',[{primitiveType:'Via',primitiveId:'b',net:'GND'}]);
  await instance.menu.drain();
  await instance.menu.drain();
  assert.equal(drawn.size,0);
  assert.equal(openWindows.size,0);
  assert.equal(selected,null);
  assert.ok(cancelledSearch);
  assert.equal(cancelledSearch.next().done,true);
  assert.equal(cancelledSession.activeSearch,undefined);
  assert.equal(cancelledSession.groups.length,0);
  assert.equal(cancelledSession.previewBoard,undefined);
  assert.equal(cancelledSession.routePreviews,undefined);
  assert.equal(cancelledSession.debugLog,undefined);
  assert.equal(exportedLogs.length,2);
  assert.match(exportedLogs[1].text,/log\.export.*"calculating":true/);
  assert.doesNotMatch(exportedLogs[1].text,/preview\.render/);
  assert.equal(instance.menu.currentSession(),null);
  assert.ok(logs.some(entry=>entry.message.includes('已取消回流路径检查')));
});

test('a non-plated multilayer pad is rejected as a cross-layer endpoint', async () => {
  const pad={primitiveType:'Pad',primitiveId:'unplated',net:'GND',x:5,y:6,layer:12,metallization:false};
  context.eda={pcb_PrimitivePad:{get:async()=>pad}};
  await assert.rejects(api.readEndpoint({primitiveType:'Pad',primitiveId:'unplated'},undefined,[1,2]),/孔壁未金属化/);
});
