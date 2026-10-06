// Test-only process harness. It cannot choose a provider executable or model argv.
// Environment omission is NOT OS filesystem isolation or subscription authentication.
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const executable=process.execPath,script=fileURLToPath(new URL('./fake-provider.mjs',import.meta.url));
const modes=new Set(['success','stall','oversize','wrong-request','descendant','stderr']);
export async function runFakeProvider({requestId,input,mode='success',deadlineMs=1000,maxInputBytes=16384,maxOutputBytes=32768,maxStderrBytes=2048,signal}){
  if(!['darwin','linux'].includes(process.platform))throw new Error('Owned process-group contract is POSIX-only');
  if(!modes.has(mode)||typeof requestId!=='string'||!/^request-[A-Za-z0-9-]{1,64}$/.test(requestId)||typeof input!=='string')throw new Error('Invalid fake request');
  for(const value of [deadlineMs,maxInputBytes,maxOutputBytes,maxStderrBytes])if(!Number.isSafeInteger(value)||value<1||value>262144)throw new Error('Invalid fake limits');
  const wire=JSON.stringify({requestId,input})+'\n';
  if(Buffer.byteLength(wire)>maxInputBytes)throw new Error('Input budget exceeded before spawn');
  if(signal?.aborted)return {status:'cancelled',spawned:false,modelRun:false};
  const root=await mkdtemp(path.join(tmpdir(),'note-app-fake-'));
  const env=Object.freeze({NOTE_APP_FAKE_MODE:mode});
  let child,timer,onAbort;let reason=null,output='',errorBytes=0,outputBytes=0;
  const kill=()=>{if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}};
  try{
    if(signal?.aborted)return {status:'cancelled',spawned:false,modelRun:false};
    child=spawn(executable,[script],{cwd:root,env,detached:true,stdio:['pipe','pipe','pipe']});
    const closed=new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(code,exitSignal)=>resolve({code,exitSignal}));
    });
    const terminate=value=>{reason??=value;kill();};
    onAbort=()=>terminate('cancelled');signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    timer=setTimeout(()=>terminate('deadline'),deadlineMs);
    child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>maxOutputBytes)terminate('output-budget');else output+=chunk.toString('utf8');});
    child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes>maxStderrBytes)terminate('stderr-budget');});
    child.stdin.on('error',()=>{if(reason===null)terminate('input-failed');});
    child.stdin.end(wire);
    const exit=await closed;
    if(reason)return {status:reason,spawned:true,pid:child.pid,outputBytes,errorBytes,modelRun:false};
    if(exit.code!==0||exit.exitSignal)return {status:'process-failed',spawned:true,modelRun:false};
    // Only one authored fixture frame. No wire idle/exit event is semantic completion.
    const lines=output.split('\n');
    if(lines.length!==2||lines[1]!=='')return {status:'invalid-frame',spawned:true,modelRun:false};
    let frame;try{frame=JSON.parse(lines[0]);}catch{return {status:'invalid-frame',spawned:true,modelRun:false};}
    if(!frame||Object.keys(frame).sort().join(',')!=='body,done,protocol,requestId,sequence'
      ||frame.protocol!=='note-app-nonmodel-frame-v1'||frame.requestId!==requestId||frame.sequence!==0
      ||frame.done!==true||typeof frame.body!=='string')return {status:'invalid-frame',spawned:true,modelRun:false};
    return {status:'fake-complete',body:frame.body,spawned:true,pid:child.pid,outputBytes,errorBytes,
      plan:{executableKind:'current-node',argv:['fixed-fake-provider-script'],environmentKeys:Object.keys(env),cwdKind:'owned-empty-temporary-directory'},modelRun:false};
  }finally{
    if(timer)clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);
    kill();await rm(root,{recursive:true,force:true});
  }
}
