import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createClaudePublicAdapter,assertSubscriptionAuthentication} from '../../src/summary/reading/claude-public-adapter';
import type {PublicReadingPack,ModelBinding} from '../../src/summary/reading/model-harness';
import {waitForReadyPid,waitForFixtureExit,observeFixtureChildren} from './helpers/process-startup';
const binding:ModelBinding={runId:'fixture-run',project:'zeno0505/note-app',inputHash:'a'.repeat(64),version:'public-reading-v1',attempt:1};
const pack={project:'zeno0505/note-app',sourceSha:'a'.repeat(40),sources:[],facts:[]} as PublicReadingPack;
async function fixture(authMethod='claude.ai',hang=false,options:{authStartupMs?:number;modelStartupMs?:number;holdAuth?:boolean;suppressAuthReady?:boolean}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'claude-public-fixture-')),executable=path.join(root,'synthetic-claude'),log=path.join(root,'calls.jsonl');
  const authDirectory=path.join(root,'auth'),modelDirectory=path.join(root,'model');
  await mkdir(authDirectory);await mkdir(modelDirectory);
  await writeFile(executable,`#!${process.execPath}\n
const fs=require('node:fs'),args=process.argv.slice(2),auth=args.includes('auth');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,auth?${options.authStartupMs??0}:${options.modelStartupMs??0});
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,apiKey:process.env.ANTHROPIC_API_KEY??null,home:process.env.HOME})+'\\n');
if(auth){
  ${options.holdAuth?"setInterval(()=>{},1000);":''}
  ${options.suppressAuthReady?'':`fs.writeFileSync(${JSON.stringify(path.join(authDirectory,'ready'))},String(process.pid));`}
  ${options.holdAuth?'':`console.log(JSON.stringify({loggedIn:true,authMethod:${JSON.stringify(authMethod)},apiProvider:'firstParty',subscriptionType:'team',email:'DO_NOT_RECORD@example.invalid'}));`}
}else{
  let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{
    ${hang?"setInterval(()=>{},1000);":"console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{ok:true},usage:{input_tokens:7},num_turns:2}));"}
    fs.writeFileSync(${JSON.stringify(path.join(modelDirectory,'ready'))},String(process.pid));
  });
}\n`);await chmod(executable,0o700);
  return {root,executable,log,authDirectory,modelDirectory,env:{HOME:root,PATH:process.env.PATH,ANTHROPIC_API_KEY:'SYNTHETIC_API_KEY_FORBIDDEN'},clean:()=>rm(root,{recursive:true,force:true})};
}
it('accepts only an existing claude.ai firstParty subscription without recording identity',async()=>{const f=await fixture();try{expect(assertSubscriptionAuthentication(f.executable,f.root,f.env)).toEqual({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'team'});expect(JSON.parse((await readFile(f.log,'utf8')).trim()).apiKey).toBeNull();}finally{await f.clean();}});
it('blocks API authentication before spawning any model request',async()=>{const f=await fixture('api_key');try{const adapter=createClaudePublicAdapter(f.executable,f.root,f.env);await expect(adapter.generate({binding,pack,repairErrors:[]},new AbortController().signal)).rejects.toThrow('Existing subscription login required');const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));expect(calls.length).toBe(1);expect(calls[0].args).toContain('auth');}finally{await f.clean();}});
it('requires a completed result and uses fixed no-tools/no-MCP args and sanitized env',async()=>{const f=await fixture();try{const events:string[]=[];const result=await createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},new AbortController().signal,async event=>{events.push(event);});expect(events).toEqual(['authentication','launch-requested','started']);expect(result.answer).toEqual({ok:true});expect(result.usage).toEqual({usage:{input_tokens:7},num_turns:2});const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));expect(rows.length).toBe(2);expect(rows[1].args).toContain('--tools');expect(rows[1].args).toContain('');expect(rows[1].args).toContain('{"mcpServers":{}}');expect(rows[1].apiKey).toBeNull();expect(rows[1].args).not.toContain('--bare');}finally{await f.clean();}});
it.each([
  {name:'normal startup',authStartupMs:0,modelStartupMs:0},
  {name:'slow authentication',authStartupMs:2200,modelStartupMs:0},
  {name:'slow model startup',authStartupMs:0,modelStartupMs:2200},
  {name:'both stages slow',authStartupMs:2200,modelStartupMs:2200},
])('cancels only its ready owned model process and settles before returning ($name)',async options=>{
  const f=await fixture('claude.ai',true,options),controller=new AbortController(),children=observeFixtureChildren(f.executable);
  const pending=createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},controller.signal);
  void pending.catch(()=>{});let pid:number|undefined;
  try{
    await waitForReadyPid(f.authDirectory);pid=await waitForReadyPid(f.modelDirectory);
    const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
    expect(rows).toHaveLength(2);expect(rows[0].args).toContain('auth');expect(rows[1].args).toContain('-p');
    controller.abort();await expect(pending).rejects.toThrow('Cancelled owned model process');
    expect(()=>process.kill(pid!,0)).toThrow();
  }finally{controller.abort();await pending.catch(()=>{});await children.settle();if(pid)await waitForFixtureExit(pid);await f.clean();}
},20_000);

it.each([0,2200])('keeps authentication asynchronous and aborts its ready auth process before any paid spawn (startup %i ms)',async authStartupMs=>{
  const f=await fixture('claude.ai',false,{authStartupMs,holdAuth:true}),controller=new AbortController(),children=observeFixtureChildren(f.executable);
  const pending=createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},controller.signal);
  void pending.catch(()=>{});let pid:number|undefined;
  try{
    pid=await waitForReadyPid(f.authDirectory);
    let eventLoopContinued=false;await new Promise<void>(resolve=>setImmediate(()=>{eventLoopContinued=true;resolve();}));
    expect(eventLoopContinued).toBe(true);controller.abort();await expect(pending).rejects.toThrow('Cancelled during auth status');
    await waitForFixtureExit(pid);
    const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
    expect(rows).toHaveLength(1);expect(rows[0].args).toContain('auth');expect(rows.some(r=>r.args.includes('-p'))).toBe(false);
  }finally{controller.abort();await pending.catch(()=>{});await children.settle();if(pid)await waitForFixtureExit(pid);await f.clean();}
},15_000);

it('does not spawn any process when already cancelled',async()=>{
  const f=await fixture(),controller=new AbortController(),children=observeFixtureChildren(f.executable);controller.abort();
  try{
    await expect(createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},controller.signal)).rejects.toThrow('Cancelled before spawn');
    await expect(readFile(f.log,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  }finally{expect(await children.settle()).toBe(0);await f.clean();}
});
it('aborts at launch-requested without starting the model process',async()=>{
  const f=await fixture(),controller=new AbortController(),children=observeFixtureChildren(f.executable);
  const pending=createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},controller.signal,async event=>{if(event==='launch-requested')controller.abort();});
  try{
    await expect(pending).rejects.toThrow('Cancelled before spawn');
    const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
    expect(rows).toHaveLength(1);expect(rows[0].args).toContain('auth');expect(rows[0].args).not.toContain('-p');
  }finally{controller.abort();await pending.catch(()=>{});expect(await children.settle()).toBe(1);await f.clean();}
});
it('joins the auth child before removing a fixture whose readiness fails',async()=>{
  const f=await fixture('claude.ai',false,{holdAuth:true,suppressAuthReady:true}),controller=new AbortController(),children=observeFixtureChildren(f.executable);
  const pending=createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},controller.signal);void pending.catch(()=>{});
  let closed=0;
  await expect((async()=>{
    try{await waitForReadyPid(f.authDirectory);}
    finally{controller.abort();await pending.catch(()=>{});closed=await children.settle();await f.clean();}
  })()).rejects.toThrow('Synthetic process did not become ready');
  expect(closed).toBe(1);await expect(readFile(f.log,'utf8')).rejects.toMatchObject({code:'ENOENT'});
},10_000);

it.each([["process.stderr.write('PRIVATE_AUTH_AND_NOTE');process.exit(7)",'model_exited_unsuccessfully'],["console.log('PRIVATE_BAD_JSON')",'model_json_invalid'],["console.log(JSON.stringify({type:'result',is_error:true,result:'PRIVATE_REPLY'}))",'model_result_rejected'],["console.log(JSON.stringify({type:'result',subtype:'success'}))",'model_result_incomplete']] as const)('classifies %s as %s with only bounded process metadata',async(body,code)=>{
  const {ModelProcessFailure}=await import('../../src/summary/reading/model-process-failure');
    const f=await fixture();try{await writeFile(f.executable,`#!${process.execPath}\nif(process.argv.includes('auth'))console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'team'}));else{process.stdin.resume();process.stdin.on('end',()=>{${body}});}\n`);
      let failure:unknown;try{await createClaudePublicAdapter(f.executable,f.root,f.env).generate({binding,pack,repairErrors:[]},new AbortController().signal);}catch(e){failure=e;}
      expect(failure).toBeInstanceOf(ModelProcessFailure);const safe=failure as InstanceType<typeof ModelProcessFailure>;expect(safe.code).toBe(code);expect(safe.processInfo).toMatchObject({exitCode:code==='model_exited_unsuccessfully'?7:0,signal:'none',cleanup:'verified'});expect(safe.processInfo.durationMs).toBeGreaterThanOrEqual(0);expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|AUTH_AND_NOTE|BAD_JSON|REPLY/);
    }finally{await f.clean();}
});

it('rejects changed account at final auth and a revoked final launch guard without spawning models',async()=>{const f=await fixture();try{const adapter=createClaudePublicAdapter(f.executable,f.root,f.env);await expect(adapter.generate({binding,pack,repairErrors:[],expectedAccountId:'0'.repeat(64)},new AbortController().signal)).rejects.toThrow('account changed');await expect(adapter.generate({binding,pack,repairErrors:[],beforeLaunch:async()=>{throw Error('Synthetic revoked launch');}},new AbortController().signal)).rejects.toThrow('Synthetic revoked launch');const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));expect(rows).toHaveLength(2);expect(rows.every(r=>r.args.includes('auth'))).toBe(true);}finally{await f.clean();}});
