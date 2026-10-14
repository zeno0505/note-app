import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {isolatedEntry} from './isolated-entry.mjs';
import {waitUntil} from './wait-until.mjs';
import {buildIdentity} from './evidence.mjs';
const f=await createPhase1Fixture(),out=process.env.NOTE_APP_ORCA_EVIDENCE;
assert(out&&path.isAbsolute(out));await mkdir(out,{recursive:true});
const bin=path.dirname(f.config.orcaExecutablePath),status=JSON.parse(await readFile(path.join(bin,'status.json'),'utf8'));
status.result.runtime.appVersion='1.4.224';await writeFile(path.join(bin,'status.json'),JSON.stringify(status));
const nativeId=status._meta.runtimeId;
const script=await readFile(f.config.orcaExecutablePath,'utf8');
const marker='if(index<0)process.exit(90);';assert(script.includes(marker));
const display=`if(args[0]==='--version'){process.stdout.write('1.4.224'+String.fromCharCode(10));process.exit(0);}if(args[0]==='worktree'&&args[1]==='show'){const root=args[3].slice(3).split('::').slice(1).join('::');process.stdout.write(JSON.stringify({id:'synthetic-worktree',ok:true,_meta:{runtimeId:${JSON.stringify(nativeId)}},result:{worktree:{id:args[3].slice(3),path:root,hostId:'local',isArchived:false}}}));process.exit(0);}if(args[0]==='file'&&args[1]==='open'){const p=require('node:path');const root=args[5].slice(3).split('::').slice(1).join('::');process.stdout.write(JSON.stringify({id:'synthetic-display',ok:true,_meta:{runtimeId:${JSON.stringify(nativeId)}},result:{worktree:args[5].slice(3),relativePath:p.relative(root,args[3]).split(p.sep).join('/'),kind:'text',opened:true}}));process.exit(0);}`;
await writeFile(f.config.orcaExecutablePath,script.replace(marker,display+marker));
const before=await f.noteSnapshot();let app;const report={identity:await buildIdentity(),status:'running',scope:'actual production Electron host/preload/renderer on Mac, synthetic owned CLI/notes/profile; no real Orca or user project',checks:[],realOrcaCalls:0,modelCalls:0};
try{
 const entry=await isolatedEntry(f.root,path.join(f.profile,'note-app'),'dist/main/index.cjs',{background:true});
 app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,NOTE_APP_CONFIG:f.configPath}});const page=await app.firstWindow();
 await waitUntil(()=>page.evaluate(()=>window.noteApp.getLiveState()),s=>s.connection==='connected'&&s.workstreams.some(w=>w.noteMapping.state==='resolved'),'mapped fixture',20000);
 await page.getByRole('button',{name:/현재 관측/}).first().click();
 await page.getByTestId('project-list-item').filter({hasText:'Fictional Atlas checkout'}).locator('a').click();
 const button=page.getByRole('button',{name:'Orca에서 DAG 열기',exact:true});await button.waitFor();await waitUntil(()=>button.isEnabled(),Boolean,'exact central note availability');
 report.backgroundMode=true;assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);report.checks.push('Exact centrally-linked DAG enables production availability and project button');
 await button.click();await page.getByText('Orca가 이 워크트리의 DAG 열기 요청을 확인했습니다. AI 모델은 실행하지 않았습니다.',{exact:true}).waitFor();
 const calls=(await f.logs()).filter(c=>c.kind==='orca'&&c.args[0]==='file');assert.equal(calls.length,1);assert.equal(calls[0].args[3],path.join(f.worktrees[0],'docs','note','dag.yaml'));
 assert.equal(calls[0].args[5],'id:repo-synthetic::'+f.worktrees[0]);assert(calls[0].args.includes('--focus'));report.checks.push('One click dispatches only exact lexical DAG path and full worktree ID; validated receipt updates UI');
 assert.deepEqual(await f.noteSnapshot(),before);report.checks.push('Synthetic original DAG and note bytes preserved');
 await page.screenshot({path:path.join(out,'central-open.png'),fullPage:true,animations:'disabled'});report.status='passed';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}finally{
 await app?.close();report.cleanup=await f.cleanup();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks,error:report.error,cleanup:report.cleanup?.noExecutingTrackedSubprocesses}));
}
