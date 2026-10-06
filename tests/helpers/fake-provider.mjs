// Authored non-model provider. No Claude/Codex/Orca imports or model/network calls.
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
const input=createInterface({input:process.stdin});
input.once('line',line=>{
  const request=JSON.parse(line);input.close();
  const frame=(body,done=true,id=request.requestId)=>JSON.stringify({protocol:'note-app-nonmodel-frame-v1',requestId:id,sequence:0,body,done})+'\n';
  const mode=process.env.NOTE_APP_FAKE_MODE;
  if(mode==='stall'){setInterval(()=>{},1000);return;}
  if(mode==='oversize'){process.stdout.write('x'.repeat(200000));return;}
  if(mode==='wrong-request'){process.stdout.write(frame('fictional response',true,'foreign-request'));return;}
  if(mode==='descendant'){
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write(frame(JSON.stringify({ownedDescendantPid:child.pid})));
    child.unref();return;
  }
  if(mode==='stderr'){process.stderr.write('x'.repeat(200000));return;}
  const body=JSON.stringify({inputSha256:createHash('sha256').update(request.input).digest('hex'),
    argv:process.argv.slice(2),envKeys:Object.keys(process.env).sort(),cwd:process.cwd(),modelRun:false});
  process.stdout.write(frame(body));
});
