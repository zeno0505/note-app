/** Test-only interactive Linux/Mac review fixture. Never uses the user's profile or notes. */
import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {isolatedEntry} from './isolated-entry.mjs';
import {waitUntil} from './wait-until.mjs';
const f=await createPhase1Fixture(),runId=randomUUID(),control=path.resolve(process.env.NOTE_APP_REVIEW_CONTROL??'reviews/evidence/phase3-review-control.json');let app,watcher;
try{
 await mkdir(path.dirname(control),{recursive:true,mode:0o700});
 f.runGit(['remote','add','origin','https://github.com/example/demo.git']);
 const destination=path.join(f.root,'notes','example','demo','ui-review');await mkdir(destination,{recursive:true,mode:0o700});
 const config=JSON.parse(await readFile(f.configPath,'utf8'));config.dagQuery.pythonPath=process.env.NOTE_APP_PYTHON;config.summarySelections=[];await writeFile(f.configPath,JSON.stringify(config));
 const entry=await isolatedEntry(f.root,path.join(f.profile,'note-app'),'dist/main/index.cjs');app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,NOTE_APP_CONFIG:f.configPath}});const page=await app.firstWindow();await page.getByTestId('new-project').waitFor();
 // Native picker returns one preselected temporary directory in this review only.
 await app.evaluate(({dialog},destination)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[destination]});},destination);
 await page.evaluate(()=>window.noteApp.connectLive());const options=await waitUntil(()=>page.evaluate(()=>window.noteApp.getProjectWorkspaceOptions()),v=>v.state==='ready'&&v.options.length>0,'synthetic workspaces',30000);
 await page.evaluate(async({option,destination})=>{const input={name:'Single repo fixture',description:'Review first, then create an empty DAG without starting models.',references:[{kind:'figma',url:'https://www.figma.com/design/fixture',state:'entered'}],instructions:{mode:'custom',source:'',sourceRevision:'',text:'Preserve premises and review requirements before planning tasks.',additional:''},noteLocation:destination,repositories:[{name:'example/demo',path:option.path,workspace:{mode:'existing',worktreeId:option.worktreeId,path:option.path,branch:option.branch??''}}]};await window.noteApp.saveProjectDraft({id:null,expectedRevision:null,input});await window.noteApp.saveProjectDraft({id:null,expectedRevision:null,input:{...input,name:'Field notes demo',references:[{kind:'notion',url:'https://www.notion.so/fixture',state:'entered'},{kind:'slack',url:'https://fixture.slack.com/archives/TEST',state:'entered'},{kind:'figma',url:'https://www.figma.com/design/one',state:'entered'},{kind:'figma',url:'https://www.figma.com/design/two',state:'entered'}],repositories:[...input.repositories,{name:'backend plan',path:'/fictional/backend',workspace:{mode:'new',worktreeId:'',path:'',branch:'develop'}}]}});},{option:options.options[0],destination});await page.reload();await page.getByRole('button',{name:'Field notes demo 초안 이어서 준비',exact:true}).waitFor();
 await writeFile(control,JSON.stringify({runId,status:'ready',fixtureRoot:f.root,destination,pid:app.process().pid}));
 await new Promise(resolve=>{watcher=watch(path.dirname(control),async(_event,name)=>{if(name!==path.basename(control))return;try{const command=JSON.parse(await readFile(control,'utf8'));if(command.runId===runId&&command.status==='stop')resolve();}catch{}});process.once('SIGINT',resolve);process.once('SIGTERM',resolve);app.once('close',resolve);});
}finally{watcher?.close();if(app)await app.close().catch(()=>{});await f.cleanup();}
