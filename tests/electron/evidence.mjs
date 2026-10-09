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
export async function assertTrackedProcessesExit(pids,timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(true){
    const live=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}});
    if(live.length===0)return;
    if(Date.now()>=deadline)throw new Error(`Electron processes remained alive: ${live.join(', ')}`);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
