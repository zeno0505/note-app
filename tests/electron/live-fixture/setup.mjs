import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,symlink,realpath,lstat,readlink,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const PRIVATE_MARKER='SYNTHETIC_PRIVATE_BODY_MUST_NOT_ESCAPE';
export const HOSTILE_TITLE='<img src=x onerror="window.__liveHostileExecuted=true">';
export const ORCA_ARGV=[['status','--json'],['project','list','--json'],['worktree','list','--limit','1000','--json'],['worktree','ps','--limit','1000','--json']];
export const CODEBURN_ARGV=[['status','--format','json','--provider','claude'],['status','--format','json','--provider','codex'],['quota','--format','json']];
export async function createLiveFixture(){
  const node=process.execPath,python=process.env.NOTE_APP_PYTHON,query=process.env.NOTE_APP_DAG_QUERY_PATH;
  for(const [name,value] of Object.entries({node,python,query})) assert(value&&path.isAbsolute(value)&&!/[\r\n]/.test(value),`Trusted absolute ${name} required`);
  assert(!/\s/.test(node),'Fixture shebang requires a Node path without spaces');
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'note live production e2e ')));
  const bin=path.join(root,'synthetic cli with spaces'),vault=path.join(root,'synthetic vault'),scope=path.join(vault,'fictional atlas'),profile=path.join(root,'isolated profile');
  const worktrees=[path.join(root,'atlas checkout'),path.join(root,'handoff checkout')];
  const modePath=path.join(root,'mode.json'),callsPath=path.join(root,'calls.jsonl'),dagPath=path.join(scope,'dag.yaml');
  for(const directory of [bin,scope,profile,...worktrees.map(w=>path.join(w,'docs'))]) await mkdir(directory,{recursive:true,mode:0o700});
  const links=worktrees.map(w=>path.join(w,'docs','note'));
  for(const link of links) await symlink(scope,link);
  await writeFile(path.join(scope,'goal.md'),'# Fictional Atlas\nTemporary synthetic note.\n');
  const tasks=Array.from({length:240},(_,index)=>({id:`T-${index}`,title:index===2?HOSTILE_TITLE:`Fictional Atlas task ${index}`,status:index===0?'done':index===1?'blocked':'pending',description:PRIVATE_MARKER,...(index===0?{depends_on:['EXT-1'],commits:['abc123'],e2e:{required:true,covered_by:[]}}:{}),...(index===1?{depends_on:['T-0']}:{})}));
  const writeDag=()=>writeFile(dagPath,JSON.stringify({phases:[{id:'phase-one',tasks}]}));
  await writeDag();
  const fixtures={};
  for(const [name,index] of ['status','projects','worktrees','processes'].map((n,i)=>[n,i])){
    const source=JSON.parse(await readFile(path.resolve(`fixtures/orca/${name}.json`),'utf8'));
    source.preview=PRIVATE_MARKER;source.prompt=PRIVATE_MARKER;
    if(name==='projects')Object.assign(source.result,{totalCount:1,truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}});
    if(name==='worktrees'||name==='processes'){
      const template=source.result.worktrees[0];
      source.result.worktrees=worktrees.map((worktree,i)=>{
        const row=structuredClone(template),id=`repo-synthetic::${worktree}`;
        Object.assign(row,{path:worktree,displayName:i===0?'Fictional Atlas checkout':'Fictional handoff checkout',branch:i===0?'refs/heads/fictional-main':'',preview:PRIVATE_MARKER,prompt:PRIVATE_MARKER});
        if(name==='worktrees')Object.assign(row,{id,instanceId:`instance-${i}`,identity:{key:`wt2:local:instance-${i}`,executionHostId:'local',instanceId:`instance-${i}`},projectId:i===0?'github:example/demo':null,repoId:i===0?'repo-synthetic':null});
        else Object.assign(row,{worktreeId:id,worktreeInstanceId:`instance-${i}`,liveTerminalCount:i===0?1:null,hasAttachedPty:i===0?true:null,agents:[{paneKey:`fictional-pane-${i}`,state:i===0?'done':'handoff',lastAssistantMessage:PRIVATE_MARKER,toolInput:PRIVATE_MARKER}]});
        return row;
      });
      Object.assign(source.result,{totalCount:2,truncated:false});
    }
    fixtures[name]=source;await writeFile(path.join(bin,`${name}.json`),JSON.stringify(source));
  }
  let mode={orca:'normal',codeburn:'normal',dag:'normal'};
  const setMode=async(change)=>{mode={...mode,...change};await writeFile(modePath,JSON.stringify(mode));};await setMode({});
  const common=`const fs=require('node:fs');const args=process.argv.slice(2);const mode=JSON.parse(fs.readFileSync(${JSON.stringify(modePath)},'utf8'));const log=(extra={})=>fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({kind,pid:process.pid,args,...extra})+'\\n');log();`;
  const orca=path.join(bin,'orca synthetic'),codeburn=path.join(bin,'codeburn synthetic'),pythonWrapper=path.join(bin,'python wrapper');
  await writeFile(orca,`#!${node}\nconst kind='orca';${common}\nconst commands=${JSON.stringify(ORCA_ARGV)},names=['status','projects','worktrees','processes'];const index=commands.findIndex(v=>JSON.stringify(v)===JSON.stringify(args));if(index<0)process.exit(90);const name=names[index];if(mode.orca==='slow'){setInterval(()=>{},1000);}else if(mode.orca==='failure'&&name==='worktrees'){process.stderr.write(${JSON.stringify(PRIVATE_MARKER)});process.exitCode=3;}else{const value=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,name+'.json'),'utf8'));if(mode.orca==='empty'&&(name==='worktrees'||name==='processes')){value.result.worktrees=[];value.result.totalCount=0;}process.stdout.write(JSON.stringify(value));}\n`);
  await writeFile(codeburn,`#!${node}\nconst kind='codeburn';${common}\nif(!${JSON.stringify(CODEBURN_ARGV)}.some(v=>JSON.stringify(v)===JSON.stringify(args)))process.exit(90);if(mode.codeburn==='failure'&&args.at(-1)==='claude'){process.stderr.write(${JSON.stringify(PRIVATE_MARKER)});process.exitCode=3;}else if(args[0]==='quota'){process.stdout.write(JSON.stringify({providers:[{id:'claude',available:false,error:${JSON.stringify(PRIVATE_MARKER)},windows:[]},{id:'codex',available:true,windows:[{label:'weekly',usedPct:31,resetsAt:null}]}]}));}else{process.stdout.write(JSON.stringify({currency:'USD',today:{cost:1.25,savings:0.5,calls:4},month:{cost:12,savings:3,calls:32},privateBody:${JSON.stringify(PRIVATE_MARKER)}}));}\n`);
  // Test-only logging wrapper launches the genuine externally supplied pinned query.
  // The private script is never copied, embedded, uploaded or printed in test evidence.
  await writeFile(pythonWrapper,`#!${node}\nconst kind='dag';${common}\nif(mode.dag==='failure'){process.stderr.write(${JSON.stringify(PRIVATE_MARKER)});process.exitCode=3;}else if(mode.dag==='slow'){setInterval(()=>{},1000);}else{const child=require('node:child_process').spawn(${JSON.stringify(python)},args,{stdio:'inherit',shell:false});fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({kind:'python-child',pid:child.pid})+'\\n');child.on('error',()=>{process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1});}\n`);
  for(const file of [orca,codeburn,pythonWrapper])await chmod(file,0o700);
  const config={schemaVersion:1,orcaExecutablePath:orca,codeburnExecutablePath:codeburn,localHostId:'local',noteScopes:[{scopeId:'fictional-atlas',hostId:'local',vaultRootPath:vault,scopePath:scope,dagRelativePaths:['dag.yaml']}],dagQuery:{pythonPath:pythonWrapper,queryScriptPath:query},summarySelections:[{scopeId:'fictional-atlas',dagRelativePath:'dag.yaml',taskIds:['T-0']}]};
  const configPath=path.join(root,'trusted startup config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const logs=async()=>{try{return (await readFile(callsPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const sourceSnapshot=async()=>({files:await Promise.all(['dag.yaml','goal.md'].map(async name=>{const file=path.join(scope,name),s=await lstat(file);return {name,hash:createHash('sha256').update(await readFile(file)).digest('hex'),mtimeMs:s.mtimeMs,ino:s.ino,mode:s.mode};})),links:await Promise.all(links.map(async file=>{const s=await lstat(file);return {link:file,target:await readlink(file),ino:s.ino,mtimeMs:s.mtimeMs,mode:s.mode};}))});
  const inspect=async(pid)=>{try{const text=await readFile(`/proc/${pid}/stat`,'utf8'),parts=text.slice(text.lastIndexOf(')')+2).split(' ');return {pid,state:parts[0]==='Z'?'zombie':parts[0]==='X'?'dead':'live',procState:parts[0]};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return {pid,state:'gone'};throw error;}};
  async function quiescence(){const history=await logs(),pids=[...new Set(history.map(r=>r.pid).filter(Number.isInteger))],snapshots=history.filter(r=>r.kind==='dag').map(r=>r.args.at(-1));let lifecycle=[],passes=0;const deadline=Date.now()+10000;
    while(Date.now()<deadline){lifecycle=await Promise.all(pids.map(inspect));const remaining=(await Promise.all(snapshots.map(async file=>{try{await stat(file);return file;}catch(error){if(error.code==='ENOENT')return null;throw error;}}))).filter(Boolean);if(lifecycle.every(p=>p.state!=='live')&&!remaining.length){if(++passes===2)return {trackedSubprocessesExited:lifecycle.every(p=>p.state==='gone'),noExecutingTrackedSubprocesses:true,subprocessLifecycle:lifecycle,temporaryDagSnapshotsRemoved:true,quiescentObservationPasses:passes};}else passes=0;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error(`Synthetic subprocess cleanup incomplete: ${JSON.stringify(lifecycle)}`);
  }
  return {root,profile,configPath,config,dagPath,tasks,writeDag,setMode,logs,sourceSnapshot,quiescence,async cleanup(){const result=await quiescence();await rm(root,{recursive:true,force:true});return {...result,fixtureRootRemoved:true};}};
}
