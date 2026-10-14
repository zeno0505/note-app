import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
async function files(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())result.push(...await files(file));else result.push(file);}return result.sort();}
export async function buildIdentity(){
  const hashes={};for(const file of await files('dist')) hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  let commit=null;let workingTreeStatus=null;try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();workingTreeStatus=execFileSync('git',['status','--short'],{encoding:'utf8'}).trim();}catch{}
  return {commit,workingTreeClean:workingTreeStatus==='',workingTreeStatus,buildHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),files:hashes};
}
/** Linux zombies have exited and cannot execute; PID 1 may retain their process-table row.
 * Report them separately rather than treating kill(pid, 0) as proof of live code. */
export async function trackedProcessState(pid){
  try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return 'exited';throw error;}
  if(process.platform==='linux'){
    try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');const state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0];if(state==='Z'||state==='X')return 'zombie';}
    catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return 'exited';throw error;}
  }
  return 'executing';
}
export async function assertTrackedProcessesExit(pids,timeoutMs=5000,inspect=trackedProcessState){
  const deadline=Date.now()+timeoutMs;
  while(true){
    const states=await Promise.all([...new Set(pids)].map(async pid=>({pid,state:await inspect(pid)})));
    const live=states.filter(row=>row.state==='executing');
    if(live.length===0)return {executing:0,exitedPids:states.filter(row=>row.state==='exited').map(row=>row.pid),zombiePids:states.filter(row=>row.state==='zombie').map(row=>row.pid)};
    if(Date.now()>=deadline)throw new Error(`Electron processes remained alive: ${live.map(row=>row.pid).join(', ')}`);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
