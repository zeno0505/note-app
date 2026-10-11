// Authored non-model provider. No Claude/Codex/Orca imports or model/network calls.
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {closeSync,writeSync} from 'node:fs';
const mode=process.env.NOTE_APP_FAKE_MODE;
// Fixed test-only delay exceeds the former ordinary-success startup budget.
if(mode==='slow-success')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2100);
const phase=(name,pid=process.pid)=>writeSync(3,JSON.stringify({phase:name,pid})+'\n');
let descendantPid;
if(mode==='descendant'){
  const child=spawn(process.execPath,['-e',`setInterval(()=>{},1000);require('node:fs').writeSync(3,String(process.pid));require('node:fs').closeSync(3);`],{stdio:['ignore','ignore','ignore','pipe']});
  descendantPid=child.pid;phase('descendant',descendantPid);
  await new Promise((resolve,reject)=>{
    let ready='';child.once('error',reject);child.stdio[3].on('data',chunk=>{ready+=chunk.toString('utf8');});
    child.stdio[3].on('end',()=>Number(ready)===child.pid?resolve():reject(new Error('Owned fake descendant did not become ready')));
  });
  child.unref();
}
const input=createInterface({input:process.stdin});
input.once('line',line=>{
  const request=JSON.parse(line);input.close();
  const frame=(body,done=true,id=request.requestId)=>JSON.stringify({protocol:'note-app-nonmodel-frame-v1',requestId:id,sequence:0,body,done})+'\n';
  // The request phase follows installation of the stall handle, so cancellation
  // evidence proves a live request, rather than an async setup or spawn race.
  if(mode==='stall'){setInterval(()=>{},1000);phase('request');closeSync(3);return;}
  phase('request');
  closeSync(3);
  if(mode==='descendant'){process.stdout.write(frame(JSON.stringify({ownedDescendantPid:descendantPid})));return;}
  if(mode==='oversize'){process.stdout.write('x'.repeat(200000));return;}
  if(mode==='wrong-request'){process.stdout.write(frame('fictional response',true,'foreign-request'));return;}
  if(mode==='stderr'){process.stderr.write('x'.repeat(200000));return;}
  const body=JSON.stringify({inputSha256:createHash('sha256').update(request.input).digest('hex'),
    argv:process.argv.slice(2),envKeys:Object.keys(process.env).sort(),cwd:process.cwd(),modelRun:false});
  process.stdout.write(frame(body));
});
phase('ready');
