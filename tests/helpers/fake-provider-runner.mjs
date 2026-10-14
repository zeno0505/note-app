// Test-only process harness. It cannot choose a provider executable or model argv.
// Environment omission is NOT OS filesystem isolation or subscription authentication.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
const executable=process.execPath,script=fileURLToPath(new URL('./fake-provider.mjs',import.meta.url));
const modes=new Set(['success','slow-success','stall','oversize','wrong-request','descendant','stderr']);
async function waitForOwnedExit(pid){
  const deadline=performance.now()+5000;
  while(performance.now()<deadline){
    try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}
    if(process.platform==='linux'){
      try{
        const stat=await readFile(`/proc/${pid}/stat`,'utf8'),state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0];
        if(['Z','X'].includes(state))return;
      }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return;throw error;}
    }
    await pause(10);
  }
  throw new Error('Owned fake fixture did not exit');
}
// Hooks observe test-only phases; they cannot replace the executable, argv, or environment.
export async function runFakeProvider({requestId,input,mode='success',deadlineMs=1000,maxInputBytes=16384,maxOutputBytes=32768,maxStderrBytes=2048,signal,beforeSetup,onReady,onRequest}){
  if(!['darwin','linux'].includes(process.platform))throw new Error('Owned process-group contract is POSIX-only');
  if(!modes.has(mode)||typeof requestId!=='string'||!/^request-[A-Za-z0-9-]{1,64}$/.test(requestId)||typeof input!=='string')throw new Error('Invalid fake request');
  for(const value of [deadlineMs,maxInputBytes,maxOutputBytes,maxStderrBytes])if(!Number.isSafeInteger(value)||value<1||value>262144)throw new Error('Invalid fake limits');
  const wire=JSON.stringify({requestId,input})+'\n';
  if(Buffer.byteLength(wire)>maxInputBytes)throw new Error('Input budget exceeded before spawn');
  if(signal?.aborted)return {status:'cancelled',spawned:false,modelRun:false};
  await beforeSetup?.();
  const root=await mkdtemp(path.join(tmpdir(),'note-app-fake-'));
  const env=Object.freeze({NOTE_APP_FAKE_MODE:mode});
  let child,closed,timer,startupTimer,onAbort,hookError;
  let reason=null,output='',errorBytes=0,outputBytes=0,terminationIssued=false;
  const ownedPids=new Set();
  const kill=()=>{if(child?.pid&&!terminationIssued){try{process.kill(-child.pid,'SIGKILL');terminationIssued=true;}catch(error){if(error.code!=='ESRCH')throw error;terminationIssued=true;}}};
  try{
    if(signal?.aborted)return {status:'cancelled',spawned:false,modelRun:false};
    child=spawn(executable,[script],{cwd:root,env,detached:true,stdio:['pipe','pipe','pipe','pipe']});
    if(child.pid)ownedPids.add(child.pid);
    closed=new Promise(resolve=>{
      let spawnError;
      child.once('error',error=>{spawnError=error;});
      child.once('close',(code,exitSignal)=>resolve({code,exitSignal,spawnError}));
    });
    const terminate=value=>{reason??=value;kill();};
    onAbort=()=>terminate('cancelled');signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    // The real deadline still includes startup unless a test explicitly gates its clock.
    timer=setTimeout(()=>terminate('deadline'),deadlineMs);
    startupTimer=setTimeout(()=>terminate('startup-failed'),5000);
    child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>maxOutputBytes)terminate('output-budget');else output+=chunk.toString('utf8');});
    child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes>maxStderrBytes)terminate('stderr-budget');});
    child.stdin.on('error',()=>{if(reason===null)terminate('input-failed');});
    let phases='',ready=false,requested=false;
    child.stdio[3].on('data',chunk=>{
      phases+=chunk.toString('utf8');
      let end;
      while((end=phases.indexOf('\n'))!==-1){
        const line=phases.slice(0,end);phases=phases.slice(end+1);
        try{
          const phase=JSON.parse(line);
          if(phase.phase==='ready'&&phase.pid===child.pid&&!ready){
            ready=true;onReady?.({pid:child.pid,cwd:root});
            if(!reason)child.stdin.end(wire);
          }else if(phase.phase==='request'&&phase.pid===child.pid&&ready&&!requested){
            requested=true;clearTimeout(startupTimer);onRequest?.({pid:child.pid,cwd:root});
          }else if(phase.phase==='descendant'&&mode==='descendant'&&!ready&&Number.isSafeInteger(phase.pid)&&phase.pid>1){
            ownedPids.add(phase.pid);
          }else throw new Error('Invalid fake fixture phase');
        }catch(error){hookError??=error;terminate('fixture-failed');}
      }
    });
    const exit=await closed;
    if(hookError)throw hookError;
    if(exit.spawnError)throw exit.spawnError;
    if(reason)return {status:reason,spawned:true,pid:child.pid,outputBytes,errorBytes,modelRun:false};
    if(exit.code!==0||exit.exitSignal)return {status:'process-failed',spawned:true,pid:child.pid,modelRun:false};
    // Only one authored fixture frame. No wire idle/exit event is semantic completion.
    const lines=output.split('\n');
    if(lines.length!==2||lines[1]!=='')return {status:'invalid-frame',spawned:true,pid:child.pid,modelRun:false};
    let frame;try{frame=JSON.parse(lines[0]);}catch{return {status:'invalid-frame',spawned:true,pid:child.pid,modelRun:false};}
    if(!frame||Object.keys(frame).sort().join(',')!=='body,done,protocol,requestId,sequence'
      ||frame.protocol!=='note-app-nonmodel-frame-v1'||frame.requestId!==requestId||frame.sequence!==0
      ||frame.done!==true||typeof frame.body!=='string')return {status:'invalid-frame',spawned:true,pid:child.pid,modelRun:false};
    return {status:'fake-complete',body:frame.body,spawned:true,pid:child.pid,outputBytes,errorBytes,
      plan:{executableKind:'current-node',argv:['fixed-fake-provider-script'],environmentKeys:Object.keys(env),cwdKind:'owned-empty-temporary-directory'},modelRun:false};
  }finally{
    if(timer)clearTimeout(timer);if(startupTimer)clearTimeout(startupTimer);if(onAbort)signal?.removeEventListener('abort',onAbort);
    kill();
    // A kill request is not settlement. Reap the direct child and observe all
    // authored descendants exiting before removing their working directory.
    if(closed)await closed;
    for(const pid of ownedPids)await waitForOwnedExit(pid);
    await rm(root,{recursive:true,force:true});
  }
}
