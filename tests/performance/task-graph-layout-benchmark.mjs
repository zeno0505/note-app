/** T060, local-only graph algorithm and headless Chromium renderer prototype.
 * Run: node tests/performance/task-graph-layout-benchmark.mjs
 * Pure-only: NOTE_APP_GRAPH_SKIP_RENDERER=1 node tests/performance/task-graph-layout-benchmark.mjs
 * Optional private fixture: NOTE_APP_PRIVATE_GRAPH_FIXTURE=/absolute/file.json
 * Private inputs remain in process memory; reports contain counts/timings only.
 * This is NOT the production Vue/Electron UI, an FPS test, or release acceptance.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {cpus, platform, release} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(root, process.env.NOTE_APP_GRAPH_PERF_OUT ?? 'artifacts/t060');
const pureSamples = Number(process.env.NOTE_APP_GRAPH_PERF_SAMPLES ?? 21);
const renderSamples = Number(process.env.NOTE_APP_GRAPH_RENDER_SAMPLES ?? 11);
assert(Number.isInteger(pureSamples) && pureSamples >= 3);
assert(Number.isInteger(renderSamples) && renderSamples >= 3);
await mkdir(out, {recursive:true});
async function bundle(code, platform, format, name) {
  const result = await build({stdin:{contents:code,resolveDir:root,loader:'ts'},bundle:true,platform,format,write:false,...(name?{globalName:name}:{})});
  return result.outputFiles[0].text;
}
const sourceFiles=['src/shared/task-graph-layout.ts','src/main/task-graph.ts','src/shared/task-graph-transport.ts'];
const sourceSha256=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
const nodeModule = path.join(out, 'benchmark-api.mjs');
await writeFile(nodeModule, await bundle(`export * from './src/shared/task-graph-layout'; export {produceTaskGraph} from './src/main/task-graph'; export {assembleGraphSnapshot} from './src/shared/task-graph-transport';`, 'node', 'esm'));
const api = await import(pathToFileURL(nodeModule).href + '?run=' + Date.now());
const browserBundle = await bundle(`export * from './src/shared/task-graph-layout';`, 'browser', 'iife', 'GraphAPI');
const round = n => Math.round(n * 10000) / 10000;
function stats(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  return {samples:sorted.length,minMs:round(sorted[0]),p50Ms:round(sorted[Math.floor(sorted.length/2)]),p95Ms:round(sorted[Math.ceil(sorted.length*.95)-1]),maxMs:round(sorted.at(-1))};
}
function measure(fn, samples=pureSamples, batch=1) {
  for(let i=0;i<3;i++)fn();
  const values=[];let result;
  for(let i=0;i<samples;i++){const start=performance.now();for(let b=0;b<batch;b++)result=fn();values.push((performance.now()-start)/batch);}
  return {timing:{...stats(values),batch},result};
}
const authority = {projectId:'benchmark-project',dagId:'benchmark-dag',sessionKey:'benchmark-session'};
function model(tasks) {
  return {dagId:authority.dagId,sourceHash:'benchmark-source',sourceMtimeMs:0,observedAt:'2026-10-14T00:00:00.000Z',doneStatus:'done',tasks:tasks.map(t=>({...t,e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed'})),statusCounts:[],coverage:{tasksTotal:tasks.length,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]};
}
function synthetic(count, shape) {
  const id=i=>'S-'+String(i+1).padStart(5,'0');
  const width=100;
  return Array.from({length:count},(_,i)=>({id:id(i),title:'Synthetic benchmark task '+(i+1),status:'pending',phase:null,dependencies:(shape==='chain'?(i?[i-1]:[]):shape==='star'?(i?[0]:[]):i>=width?[i-width]:[]).map(n=>({id:id(n),scope:'internal'}))}));
}
async function privateFixture(file) {
  const data=JSON.parse(await readFile(file,'utf8'));
  assert(Array.isArray(data.tasks)&&Array.isArray(data.edges),'Private fixture shape is unsupported');
  const scopes=new Map(data.edges.map(e=>[JSON.stringify([e.source,e.target]),e.scope]));
  return data.tasks.map(t=>({id:t.id,title:t.title??null,status:t.status??null,phase:t.phase??null,dependencies:t.dependencies.map(d=>typeof d==='string'?{id:d,scope:scopes.get(JSON.stringify([d,t.id]))??'internal'}:d)}));
}
const datasets=[];
for(const shape of ['breadth','chain'])for(const count of [0,1,387,1001,10000])datasets.push({name:`synthetic-${shape}-${count}`,shape,private:false,tasks:synthetic(count,shape)});
datasets.push({name:'synthetic-star-10000',shape:'star',private:false,tasks:synthetic(10000,'star')});
if(process.env.NOTE_APP_PRIVATE_GRAPH_FIXTURE)datasets.push({name:'private-local-fixture',shape:'source',private:true,tasks:await privateFixture(process.env.NOTE_APP_PRIVATE_GRAPH_FIXTURE)});
const html=`<!doctype html><meta charset="utf-8"><title>T060 benchmark only</title><style>
html,body{margin:0;background:#fafafa;font:13px sans-serif}#viewport{position:relative;width:1280px;height:800px;overflow:hidden;contain:strict;background:#f3f4f6}svg,#cards{position:absolute;inset:0;width:100%;height:100%}.card{position:absolute;box-sizing:border-box;border:1px solid #8291a6;background:white;border-radius:6px;padding:6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.card small{display:block;color:#475569;margin-top:4px}path{fill:none;stroke:#64748b;stroke-width:1.5}
</style><div id="viewport"><svg id="routes" xmlns="http://www.w3.org/2000/svg"></svg><div id="cards"></div></div>`;
await writeFile(path.join(out,'prototype.html'),html);
const report={status:'running',createdAt:new Date().toISOString(),sourceSha256,scope:'Node pure algorithms plus headless Chromium DOM-card/SVG-path micro-prototype. Not production app or Electron acceptance; no FPS claim.',environment:{node:process.version,platform:platform(),release:release(),cpu:cpus()[0]?.model,cpuCount:cpus().length,chromium:null,executable:process.env.NOTE_APP_CHROMIUM??'/usr/bin/chromium'},method:{viewport:{x:0,y:0,width:1280,height:800},deviceScaleFactor:1,pureWarmups:3,pureSamples,rendererWarmups:2,rendererSamples:renderSamples,rendererOrder:'paired alternating full/cull order at identical origin viewport',timer:'Node performance.now; browser performance.now in page',normalization:'produceTaskGraph includes validation, SCC, chunk serialization/hash and internal reassembly validation; separately measured assembleGraphSnapshot is receiver-side validation',breadth:'100-wide layered DAG: predecessor is row i-100, first 100 tasks have none',culling:'production visibleGraphNodes and BVH-indexed visibleGraphRoutes; intersecting segments retained, including pass-through paths',renderSync:'selection + element creation/mount + forced layout; cleanup before timer',renderTwoRaf:'same start through two requestAnimationFrame callbacks, a frame-opportunity latency proxy, not proof of screen presentation',limits:'No GPU/Canvas comparison. No production Vue, worker/IPC, keyboard/a11y or Mac Electron verification. Star case exposes routes that remain unbounded by card culling. Results sensitive to CPU contention, GC and browser scheduling.'},checks:[],cases:[]};
let browser,page;
try {
  if(process.env.NOTE_APP_GRAPH_SKIP_RENDERER==='1')report.rendererState='skipped';
  else try {
  browser=await chromium.launch({executablePath:report.environment.executable,headless:true,chromiumSandbox:true,args:['--disable-dev-shm-usage']});
  report.environment.chromium=browser.version();
  const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
  await context.route('**/*',route=>route.abort()); // No external requests, including for private data.
  page=await context.newPage();
  await page.setContent(html);await page.addScriptTag({content:browserBundle});
  await page.evaluate(()=>{
    const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.setSource=snapshot=>{window.graph=GraphAPI.layoutGraphSnapshot(snapshot,{grouping:'ungrouped',groupKey:null});};
    window.renderBenchmark=async(mode,view)=>{
      const cards=document.querySelector('#cards'),svg=document.querySelector('#routes');
      cards.replaceChildren();svg.replaceChildren();document.querySelector('#viewport').offsetHeight;await frames();
      const graph=window.graph,start=performance.now();
      const nodes=mode==='full'?graph.nodes:GraphAPI.visibleGraphNodes(graph,view);
      const edges=mode==='full'?graph.edges:GraphAPI.visibleGraphRoutes(graph,view);
      const selected=performance.now();svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.width} ${view.height}`);
      const nodeFragment=document.createDocumentFragment(),edgeFragment=document.createDocumentFragment();
      for(const node of nodes){const card=document.createElement('div');card.className='card';card.dataset.id=node.id;card.style.cssText=`left:${node.x-view.x}px;top:${node.y-view.y}px;width:${node.width}px;height:${node.height}px`;const label=document.createElement('span');label.textContent=graph.index.nodeById.get(node.id).title??node.id;const status=document.createElement('small');status.textContent=graph.index.nodeById.get(node.id).declaredStatus??'unknown';card.append(label,status);nodeFragment.append(card);}
      for(const edge of edges){const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',GraphAPI.graphRoutePath(edge));edgeFragment.append(p);}
      cards.append(nodeFragment);svg.append(edgeFragment);document.querySelector('#viewport').offsetHeight;
      cards.lastElementChild?.getBoundingClientRect();svg.getBoundingClientRect();
      const syncEnd=performance.now();await frames();const end=performance.now();
      return {selectionMs:selected-start,mountLayoutMs:syncEnd-selected,syncMs:syncEnd-start,twoRafMs:end-start,nodes:cards.children.length,paths:svg.children.length,totalElements:document.querySelector('#viewport').querySelectorAll('*').length};
    };
  });
  report.rendererState='available';
  }catch(error){report.rendererState='blocked';report.rendererBlocker=String(error);await browser?.close();browser=null;page=null;}
  for(const data of datasets){
    const input=model(data.tasks);
    const normalization=measure(()=>api.produceTaskGraph(input,authority));
    const assembled=measure(()=>api.assembleGraphSnapshot(normalization.result.metadata,normalization.result.chunks));
    const snapshot=assembled.result;
    const layoutTiming=measure(()=>api.layoutGraphSnapshot(snapshot,{grouping:'ungrouped',groupKey:null}));
    const layout=layoutTiming.result;
    assert.equal(layout.nodes.length,snapshot.nodes.length);
    const before=JSON.stringify(layout.nodes);
    const positions=[{x:0,y:0,width:1280,height:800},{x:Math.max(0,(layout.width-1280)/2),y:Math.max(0,(layout.height-800)/2),width:1280,height:800},{x:Math.max(0,layout.width-1280),y:Math.max(0,layout.height-800),width:1280,height:800}];
    const culling=positions.map(view=>{
      const timed=measure(()=>api.visibleGraphNodes(layout,view),pureSamples,100);
      const brute=layout.nodes.filter(n=>n.x<=view.x+view.width&&n.x+n.width>=view.x&&n.y<=view.y+view.height&&n.y+n.height>=view.y);
      assert.equal(JSON.stringify(timed.result.map(n=>n.id).sort()),JSON.stringify(brute.map(n=>n.id).sort()),'Culling disagrees with geometric oracle');
      const routes=measure(()=>api.visibleGraphRoutes(layout,view),pureSamples,10);
      const bruteRoutes=layout.edges.filter(route=>route.points.some((p,i)=>{if(!i)return false;const q=route.points[i-1];return Math.min(p.x,q.x)<=view.x+view.width&&Math.max(p.x,q.x)>=view.x&&Math.min(p.y,q.y)<=view.y+view.height&&Math.max(p.y,q.y)>=view.y;}));
      assert.equal(JSON.stringify(routes.result.map(r=>r.id).sort()),JSON.stringify(bruteRoutes.map(r=>r.id).sort()),'Route index disagrees with segment-scan oracle');
      return {viewport:view,visibleNodes:timed.result.length,timing:timed.timing,visibleRoutes:routes.result.length,routeTiming:routes.timing};
    });
    const projection=measure(()=>api.projectGraphViewport(layout,positions[0]));
    assert.equal(projection.result.counts.nodes.visible+projection.result.counts.nodes.viewportOutside+projection.result.counts.nodes.filtered+projection.result.counts.nodes.otherGroup,snapshot.nodes.length);
    assert.equal(projection.result.counts.edges.internal+projection.result.counts.edges.boundary+projection.result.counts.edges.outside,snapshot.edges.length);
    assert.equal(JSON.stringify(layout.nodes),before,'Projection changed layout geometry');
    const reordered={...snapshot,nodes:[...snapshot.nodes].reverse(),edges:[...snapshot.edges].reverse()};
    assert.equal(JSON.stringify(api.layoutGraphSnapshot(reordered,{grouping:'ungrouped',groupKey:null}).nodes),before,'Input order changed deterministic geometry');
    let renderer=null;
    if(page){
    await page.evaluate(snapshot=>window.setSource(snapshot),snapshot);
    const runs={full:[],culled:[]};
    for(let i=-2;i<renderSamples;i++)for(const mode of i%2===0?['full','culled']:['culled','full']){
      const result=await page.evaluate(({mode,view})=>window.renderBenchmark(mode,view),{mode,view:positions[0]});
      if(i>=0)runs[mode].push(result);
    }
    renderer={};
    for(const [mode,values]of Object.entries(runs)){
      assert(values.every(v=>v.nodes===values[0].nodes&&v.paths===values[0].paths),'Renderer count changed across identical runs');
      renderer[mode]={nodes:values[0].nodes,paths:values[0].paths,totalElements:values[0].totalElements,selection:stats(values.map(v=>v.selectionMs)),mountAndLayout:stats(values.map(v=>v.mountLayoutMs)),sync:stats(values.map(v=>v.syncMs)),throughTwoRaf:stats(values.map(v=>v.twoRafMs))};
    }
    assert.equal(renderer.full.nodes,snapshot.nodes.length);assert.equal(renderer.full.paths,layout.edges.length);
    assert.equal(renderer.culled.nodes,culling[0].visibleNodes);
    for(const entry of culling.slice(1)){
      const moved=await page.evaluate(view=>window.renderBenchmark('culled',view),entry.viewport);
      assert.equal(moved.nodes,entry.visibleNodes,'Non-origin renderer disagrees with culling');
    }
    if(data.name==='synthetic-breadth-10000'){
      await page.evaluate(view=>window.renderBenchmark('culled',view),positions[0]);
      await page.screenshot({path:path.join(out,'synthetic-breadth-10000-culled.png')});
    }
    }
    const result={name:data.name,privateInput:data.private,shape:data.shape,sourceNodes:snapshot.nodes.length,sourceEdges:snapshot.edges.length,layoutNodes:layout.nodes.length,layoutRoutes:layout.edges.length,columns:layout.columns.length,world:{width:layout.width,height:layout.height},normalizeAndValidate:normalization.timing,receiverAssemble:assembled.timing,layout:layoutTiming.timing,culling,fullProjection:{timing:projection.timing,counts:projection.result.counts},renderer};
    report.cases.push(result);
    await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({case:result.name,nodes:result.sourceNodes,edges:result.sourceEdges,layoutP50Ms:result.layout.p50Ms,fullSyncP50Ms:renderer?.full.sync.p50Ms??null,culledSyncP50Ms:renderer?.culled.sync.p50Ms??null,queriedNodes:culling[0].visibleNodes,queriedRoutes:culling[0].visibleRoutes}));
  }
  report.checks.push('All source node/edge counts retained','Origin/middle/end node culling equals brute-force geometric oracle','Origin/middle/end route index equals brute-force segment-scan oracle','Projection counts partition complete source','Projection does not move nodes','Reversing input nodes/edges preserves deterministic node geometry','Private fixture has no exported titles, IDs, dependency tuples or screenshots');
  if(page)report.checks.push('Non-origin browser card counts equal query counts','Both renderers use identical labels, status lines, card dimensions, SVG paths, viewport, and frame waits','All browser network requests blocked');
  const finalHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
  assert.equal(JSON.stringify(finalHashes),JSON.stringify(sourceSha256),'Production source changed during benchmark; rerun for a consistent result');
  report.status=page?'passed':'pure-passed-renderer-'+report.rendererState;
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;}
finally{await browser?.close();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,cases:report.cases.length,evidenceDirectory:path.relative(root,out),error:report.error}));
