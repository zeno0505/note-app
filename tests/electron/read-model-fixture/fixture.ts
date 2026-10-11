import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,realpath,rm,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createCodeBurnReader} from '../../../src/summary/budget/codeburn';
import {createDagReader,type DagReadResult} from '../../../src/facts/dag-read-model';
import {extractProjectionContext} from '../../../src/summary/context/projection';
import {createSummaryStore} from '../../../src/summary/claims';
import {buildContextPack} from '../../../src/summary/context';
export const scenarios=['codeburn-normal','codeburn-errors','codeburn-timeout','codeburn-slow','dag-first','dag-cache','dag-unselected','dag-changed','dag-slow','dag-cancel'] as const;
export type Scenario=typeof scenarios[number];
export async function createFixture(){
 const node=process.env.NOTE_APP_TEST_NODE,python=process.env.NOTE_APP_PYTHON,script=process.env.NOTE_APP_DAG_QUERY_PATH;
 for(const [name,value] of Object.entries({node,python,script}))if(!value||!isAbsolute(value)||/[\r\n]/.test(value))throw new Error(`Trusted ${name} configuration required`);
 if(/\s/.test(node!))throw new Error('Node path cannot contain whitespace');
 const root=await realpath(await mkdtemp(join(tmpdir(),'note-read-model-e2e-')));
 const mode=join(root,'mode.json'),calls=join(root,'calls.jsonl'),dag=join(root,'dag.yaml');
 const log=`require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind,pid:process.pid,args:process.argv.slice(2)})+'\\n');`;
 const codeburn=join(root,'codeburn-fixture');
 await writeFile(codeburn,`#!${node}\nconst kind='codeburn';${log}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(![JSON.stringify(['status','--format','json','--provider','claude']),JSON.stringify(['status','--format','json','--provider','codex']),JSON.stringify(['quota','--format','json'])].includes(JSON.stringify(args)))process.exit(9);const mode=JSON.parse(fs.readFileSync(${JSON.stringify(mode)},'utf8')).codeburn;if(mode==='slow')setInterval(()=>{},1000);else if(mode==='malformed')process.stdout.write('{');else if(mode==='failed'){process.stderr.write('SYNTHETIC_PRIVATE_ERROR');process.exitCode=2;}else if(args[0]==='quota')process.stdout.write(JSON.stringify({providers:[{id:'claude',available:false,error:'SYNTHETIC_PRIVATE_ERROR',windows:[]},{id:'codex',available:true,windows:[{label:'weekly',usedPct:31,resetsAt:null}]}]}));else process.stdout.write(JSON.stringify({currency:'USD',today:{cost:1.25,savings:0.5,calls:4},month:{cost:12,savings:3,calls:32},privateBody:'SYNTHETIC_PRIVATE_ERROR'}));`);await chmod(codeburn,0o700);
 const wrapper=join(root,'python-wrapper');
 // Fixed test-only wrapper logs launch count and delays execution; it never stores the external query script.
 await writeFile(wrapper,`#!${node}\nconst kind='dag';${log}\nlet terminating=false;process.on('SIGTERM',()=>{terminating=true;});const fs=require('node:fs');const delay=JSON.parse(fs.readFileSync(${JSON.stringify(mode)},'utf8')).dagDelay;setTimeout(()=>{if(terminating){process.exit(0);return;}const child=require('node:child_process').spawn(${JSON.stringify(python)},process.argv.slice(2),{stdio:'inherit',shell:false});fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind:'python-child',pid:child.pid})+'\\n');child.on('error',()=>{process.exitCode=1});child.on('exit',(code)=>{process.exitCode=code??1});},delay);`);await chmod(wrapper,0o700);
 const tasks=Array.from({length:1000},(_,i)=>({id:`T-${i}`,title:`Synthetic task ${i}`,status:i===0?'done':'pending',description:'Synthetic unretained context. '.repeat(30),...(i===0?{depends_on:['EXT-1'],commits:['abc123'],e2e:{required:true,covered_by:[]}}:i===2?{e2e:{required:true,covered_by:['T-999']}}:{})}));
 const writeDag=()=>writeFile(dag,JSON.stringify({phases:[{tasks}]}));await writeDag();
 let currentMode={codeburn:'normal',dagDelay:0};const setMode=async(change:Partial<typeof currentMode>)=>{currentMode={...currentMode,...change};await writeFile(mode,JSON.stringify(currentMode));};await setMode({});
 const codeReader=createCodeBurnReader({executablePath:codeburn,timeoutMs:1200});
 const dagOptions={pythonPath:wrapper,queryScriptPath:script!,registrations:[{dagId:'synthetic-dag',canonicalDagPath:dag}],timeoutMs:20000};
 const dagReader=createDagReader(dagOptions);let firstHash:string|undefined;let projectionHash:string|undefined;let summaryStore:ReturnType<typeof createSummaryStore>|undefined;let controller:AbortController|null=null;let pending:Promise<unknown>|null=null;
 const logs=async()=>{try{return (await readFile(calls,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}};
 const dagCalls=async()=> (await logs()).filter(entry=>entry.kind==='dag').length;
 const summarize=(result:DagReadResult)=>result.ok?{ok:true,unchanged:result.unchanged,sourceHash:result.value.sourceHash,coverage:result.value.coverage,representativeTasks:result.value.tasks.slice(0,3),verifiedFacts:result.value.verifiedFacts}:result;
 async function execute(scenario:Scenario,signal:AbortSignal){
  if(scenario==='codeburn-normal'){
   await setMode({codeburn:'normal'});const claude=await codeReader.read('claude-status'),codex=await codeReader.read('codex-status'),quota=await codeReader.read('quota');assert(claude.ok&&codex.ok&&quota.ok);assert.equal(quota.value.kind,'quota');if(quota.value.kind==='quota'){assert.equal(quota.value.providers[0].quotaData,'unavailable');assert.equal(quota.value.providers[0].agentAvailability,'unknown');}assert(!JSON.stringify([claude,codex,quota]).includes('SYNTHETIC_PRIVATE_ERROR'));return {status:'CodeBurn projection verified',claude,codex,quota,privatePayloadDiscarded:true};
  }
  if(scenario==='codeburn-errors'){
   await setMode({codeburn:'malformed'});const malformed=await codeReader.read('claude-status');await setMode({codeburn:'failed'});const failed=await codeReader.read('codex-status');assert.deepEqual(malformed.ok?null:malformed.error.kind,'invalid-json');assert.deepEqual(failed.ok?null:failed.error.kind,'command-failed');assert(!JSON.stringify(failed).includes('SYNTHETIC_PRIVATE_ERROR'));return {status:'Failures remain failures',malformed,failed,notZeroUsage:true};
  }
  if(scenario==='codeburn-timeout'||scenario==='codeburn-slow'){
   await setMode({codeburn:'slow'});const result=await codeReader.read('quota',{signal});assert(!result.ok);assert.equal(result.error.kind,scenario==='codeburn-slow'?'cancelled':'timeout');await setMode({codeburn:'normal'});const retry=await codeReader.read('quota');assert(retry.ok);return {status:scenario==='codeburn-slow'?'CodeBurn cancelled and retried':'CodeBurn timeout and retry verified',result,retrySucceeded:true};
  }
  if(scenario==='dag-unselected'){tasks[999].title='Synthetic unrelated task change';await writeDag();}
  if(scenario==='dag-changed'){tasks[0].status='running';await writeDag();}
  if(scenario==='dag-slow'||scenario==='dag-cancel'){await setMode({dagDelay:300});tasks[0].title=`Synthetic refreshed ${scenario}`;await writeDag();}else await setMode({dagDelay:0});
  const before=await readFile(dag);const beforeStat=await stat(dag);const count=await dagCalls();
  const reader=scenario==='dag-cancel'?createDagReader(dagOptions):dagReader;
  const result=await reader.read('synthetic-dag',{signal});
  if(scenario==='dag-cancel'){assert(!result.ok);assert.equal(result.error.kind,'cancelled');const reuse=await reader.read('synthetic-dag');assert(!reuse.ok);assert.equal(reuse.error.kind,'cleanup_unverified');return {status:'DAG query cancelled',result,reuse,retiredReaderReuseRejected:true};}
  assert(result.ok,JSON.stringify(result));assert.equal(result.value.tasks.length,1000);assert.deepEqual(result.value.verifiedFacts,[]);assert.deepEqual(await readFile(dag),before);assert.equal((await stat(dag)).mtimeMs,beforeStat.mtimeMs);
  assert.equal(result.value.tasks[0].e2e.coverage,'unmet');assert.equal(result.value.tasks[1].e2e.coverage,'undeclared');assert.equal(result.value.tasks[0].dependencies[0].scope,'external');assert.equal(result.value.tasks[0].commitVerification,'not-performed');
  const extracted=extractProjectionContext({schemaVersion:1,dagId:result.value.dagId,dag:result.value,requestedTaskIds:['T-0'],excerpts:[],previousSources:[],priorApprovedSummary:null,limits:{maxBytes:12000,maxApproxTokens:12000,maxRecords:8}});
  const context=buildContextPack(extracted.input);
  assert(!JSON.stringify(context).includes(result.value.sourceHash));
  assert.equal(context.records.length,1);assert.equal(context.coverage.complete,false);assert.equal(context.coverage.totalCount,null);assert(context.coverage.unknowns.some(text=>text.includes('Goal document')));assert(!JSON.stringify(context).includes('Synthetic task 999'));
  const contextPreparation={fullDagTasks:1000,explicitlySelectedTasks:1,recordsForAgent:context.records.length,serializedBytes:context.usage.bytes,coverage:'partial',goal:'unknown',unselectedTaskContentAbsent:true,upstreamProvenanceKeptLocal:true,agentInvoked:false};
  const afterCount=await dagCalls();
  if(scenario==='dag-first'){assert.equal(result.unchanged,false);firstHash=result.value.sourceHash;projectionHash=context.records[0].sourceHash;summaryStore=createSummaryStore(context);}
  if(scenario==='dag-cache'){assert(firstHash,'Run first DAG observation before cache check');assert.equal(result.unchanged,true);assert.equal(afterCount,count);}
  if(scenario==='dag-unselected'){tasks[999].title='Synthetic unrelated task change';await writeDag();}
  let unrelatedEditNoSummaryRefresh:boolean|null=null;
  if(scenario==='dag-unselected'){assert(summaryStore);assert.notEqual(result.value.sourceHash,firstHash);assert.equal(context.records[0].sourceHash,projectionHash);assert.equal(summaryStore.updateContext(context).changed,false);unrelatedEditNoSummaryRefresh=true;}
  if(scenario==='dag-changed'){assert(firstHash);assert.notEqual(context.records[0].sourceHash,projectionHash);assert.notEqual(result.value.sourceHash,firstHash);assert.equal(result.unchanged,false);assert.equal(afterCount,count+1);}
  return {status:scenario==='dag-cache'?'Unchanged DAG skips query':scenario==='dag-unselected'?'Unrelated edit skips summary refresh':scenario==='dag-changed'?'Changed DAG refreshed':scenario==='dag-slow'?'Asynchronous DAG query complete':'1000-task DAG verified',contextPreparation,unrelatedEditNoSummaryRefresh,...summarize(result),queryLaunches:afterCount,queryLaunchDelta:afterCount-count,sourceBytesUnchanged:true};
 }
 return {
  async run(scenario:Scenario){if(pending)return {status:'Reader busy',kind:'busy'};controller=new AbortController();pending=execute(scenario,controller.signal);try{return await pending;}finally{pending=null;controller=null;}},
  async stats(){const history=await logs();return {running:pending!==null,codeburnLaunches:history.filter(e=>e.kind==='codeburn').length,dagLaunches:history.filter(e=>e.kind==='dag').length,pythonLaunches:history.filter(e=>e.kind==='python-child').length};},
  cancel(){controller?.abort();return {cancelRequested:controller!==null};},
  async cleanup(){controller?.abort();await pending?.catch(()=>{});const history=await logs();const pids=[...new Set<number>(history.map(e=>e.pid).filter(Number.isInteger))];const snapshots=history.filter(e=>e.kind==='dag').map(e=>e.args.at(-1));const deadline=Date.now()+8000;
   type Lifecycle={pid:number;kind:string;state:'gone'|'zombie'|'dead'|'live'|'unknown';procState?:string;parentPid?:number;group?:number;session?:number;startTicks?:string};
   const inspect=async(pid:number):Promise<Lifecycle>=>{
    const base={pid,kind:history.find(e=>e.pid===pid)?.kind??'unknown'};
    if(process.platform==='linux'){
     try{const content=await readFile(`/proc/${pid}/stat`,'utf8');const end=content.lastIndexOf(')');const fields=content.slice(end+2).split(' ');if(end<0||fields.length<20)return {...base,state:'unknown'};const [procState,parentPid,group,session]=fields;return {...base,state:procState==='Z'?'zombie':procState==='X'?'dead':'live',procState,parentPid:Number(parentPid),group:Number(group),session:Number(session),startTicks:fields[19]};}
     catch(error){return {...base,state:['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??'')?'gone':'unknown'};}
    }
    try{process.kill(pid,0);return {...base,state:'live'};}catch(error){return {...base,state:(error as NodeJS.ErrnoException).code==='ESRCH'?'gone':'unknown'};}
   };
   let lifecycle:Lifecycle[]=[];let quiescentPasses=0;
   while(true){lifecycle=await Promise.all(pids.map(inspect));const unresolved=lifecycle.filter(p=>p.state==='live'||p.state==='unknown');const remaining=(await Promise.all(snapshots.map(async p=>{try{await stat(p);return p;}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?null:p;}}))).filter(Boolean);
    if(!unresolved.length&&!remaining.length){if(++quiescentPasses>=2)break;}else quiescentPasses=0;
    if(Date.now()>deadline){const diagnostic={lifecycle,remainingSnapshots:remaining.length};console.error('Read-model cleanup diagnostic '+JSON.stringify(diagnostic));throw new Error(`Fixture cleanup incomplete: ${JSON.stringify(diagnostic)}`);}
    await new Promise(resolve=>setTimeout(resolve,50));
   }
   const allExited=lifecycle.every(p=>p.state==='gone');console.log('Read-model subprocess lifecycle '+JSON.stringify(lifecycle));
   await rm(root,{recursive:true,force:true});return {trackedSubprocessesExited:allExited,noExecutingTrackedSubprocesses:true,subprocessLifecycle:lifecycle,quiescentObservationPasses:quiescentPasses,temporarySnapshotsRemoved:true,fixtureRootRemoved:true,codeburnCalls:history.filter(e=>e.kind==='codeburn').map(e=>e.args),dagQueryLaunches:history.filter(e=>e.kind==='dag').length};}
 };
}
