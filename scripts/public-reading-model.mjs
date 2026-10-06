import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{output:{type:'string'},execute:{type:'boolean',default:false},'approved-public-sha':{type:'string'},'claude-path':{type:'string'}}});
if(!values.output||!path.isAbsolute(values.output))throw Error('Private absolute --output directory required');
const out=values.output;await mkdir(out,{mode:0o700,recursive:true});
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:1024*1024}).trim();
const sha=values['approved-public-sha'];if(!sha||!/^[a-f0-9]{40}$/.test(sha))throw Error('Explicit approved public commit required');
if(git('remote','get-url','origin')!=='https://github.com/zeno0505/note-app.git'&&git('remote','get-url','origin')!=='https://github.com/zeno0505/note-app')throw Error('Unexpected repository');
// Proof that the chosen commit is already in the fetched public feature history.
git('merge-base','--is-ancestor',sha,'origin/feat/phase1-foundation');
const sources=[];
function excerpt(file,needle,after=4){const text=git('show',sha+':'+file),lines=text.split('\n'),index=lines.findIndex(l=>l.includes(needle));if(index<0)throw Error('Public source anchor missing: '+file);const start=Math.max(0,index-2),end=Math.min(lines.length,index+after+1),body=lines.slice(start,end).join('\n');const id='S'+(sources.length+1);sources.push({id,path:file,lineStart:start+1,lineEnd:end,sha256:createHash('sha256').update(body).digest('hex'),excerpt:body});return id;}
const list=excerpt('src/renderer/components/LiveOverview.vue','class="project-browser"',2);
const rules=excerpt('src/summary/reading/index.ts',"kind: 'rules-only'",4);
const blocked=excerpt('src/summary/workflow/transport.ts',"state: 'blocked'",3);
const planning=excerpt('docs/phase2-resource-planning.md','Phase 2',14);
const workflow=excerpt('.github/workflows/check.yml','runs-on:',16);
const reading=excerpt('src/summary/reading/index.ts','설계 상태가 미기재',2);
const summaryAction=excerpt('src/main/live-runtime.ts','summarizeNow()',4);
const response=await fetch('https://api.github.com/repos/zeno0505/note-app/actions/runs?head_sha='+sha+'&per_page=5');if(!response.ok)throw Error('Public CI query unavailable; no model call');
const data=await response.json(),runs=data.workflow_runs.map(r=>({id:r.id,head_sha:r.head_sha,event:r.event,status:r.status,conclusion:r.conclusion,html_url:r.html_url}));if(!runs.length||runs.some(r=>r.head_sha!==sha))throw Error('Missing exact-SHA public CI');
const ciText=JSON.stringify({headSha:sha,runs});const ci='S'+(sources.length+1);sources.push({id:ci,path:'.github/workflows/check.yml#public-actions-observation',lineStart:1,lineEnd:1,sha256:createHash('sha256').update(ciText).digest('hex'),excerpt:ciText});
const success=runs.every(r=>r.status==='completed'&&r.conclusion==='success');
const facts=[
 {id:'F1',section:'implemented',state:'known',text:'프로젝트 목록의 요약을 분리하고 선택한 프로젝트 요약을 별도 영역에 표시하는 UI가 소스에 구현되어 있습니다.',sourceIds:[list],anchors:['목록','선택','요약']},
 {id:'F2',section:'implemented',state:'none',text:'일반 앱의 지금 요약은 전체 설정 소스를 새로 읽는 규칙 기반 갱신입니다. 기존 production 모델 실행은 차단되어 있고 자동 모델 호출은 없습니다.',sourceIds:[rules,blocked,summaryAction],anchors:['규칙 기반','전체','자동 모델 호출','없']},
 {id:'F3',section:'next',state:'known',text:'Phase 2의 계정 한도와 메모리 기반 동시 실행 제어는 계획 문서이며 이번 공개 입력은 실제 구현을 입증하지 않습니다. 공개 입력 검증 이후 실프로젝트 모델 요약 연결은 별도 구현·검증이 필요합니다.',sourceIds:[planning,blocked],anchors:['계정','메모리','계획','입증하지']},
 {id:'F4',section:'evidence',state:'known',text:`공개 소스 SHA ${sha}의 CI 조회 결과는 ${success?'성공':'성공 미확인'}입니다. workflow 환경은 Ubuntu 24.04, Node 24.19.0이며 타입 검사·단위 테스트·빌드를 실행합니다.`,sourceIds:[workflow,ci],anchors:[sha,success?'성공':'미확인','24.04','24.19.0','타입','테스트','빌드']},
 {id:'F5',section:'evidence',state:'unrecorded',text:'이 CI는 Mac GUI·패키지 검수와 배포 완료를 입증하지 않습니다. 공개 입력에 해당 검수·배포 결과는 미기재입니다. PR 병합을 테스트 통과나 배포 완료로 취급하지 않습니다.',sourceIds:[workflow,blocked],anchors:['Mac','미기재','배포','PR','별개']},
 {id:'F6',section:'decisions',state:'unrecorded',text:'일반 읽기 요약에서 프로젝트별 설계 상태는 미기재입니다. 미기재를 결정 사항 없음이나 설계 완료로 바꾸지 않습니다. 실제 프로젝트 모델 전송 대상·권한·검증 경계는 별도 확인해야 합니다.',sourceIds:[reading,blocked],anchors:['설계','미기재','없음','전송','확인']},
];
const pack={project:'zeno0505/note-app',sourceSha:sha,sources,facts};
await build({entryPoints:['src/summary/reading/model-harness.ts','src/summary/reading/claude-public-adapter.ts'],outdir:path.join(out,'compiled'),platform:'node',format:'esm',bundle:true,target:'node24'});
const harnessModule=await import(pathToFileURL(path.join(out,'compiled/model-harness.js'))),adapterModule=await import(pathToFileURL(path.join(out,'compiled/claude-public-adapter.js')));
const inputHash=harnessModule.publicInputHash(pack);await writeFile(path.join(out,'public-evidence-pack.json'),JSON.stringify({inputHash,pack},null,2),{mode:0o600});
console.log(JSON.stringify({stage:'prepared',sha,inputHash,sourceCount:sources.length,facts:facts.length,bytes:Buffer.byteLength(JSON.stringify(pack)),publicOnly:true,execute:values.execute}));
if(!values.execute)process.exit(0);
if(!values['claude-path']||!path.isAbsolute(values['claude-path']))throw Error('Explicit installed Claude executable required');
const cwd=path.join(out,'empty-workspace');await mkdir(cwd,{mode:0o700,recursive:true});
// Every experiment directory shares one durable per-user reservation/lock.
// Changing --output must not create another paid-call allowance.
const ledgerDirectory=process.platform==='darwin'?path.join(process.env.HOME,'Library','Application Support','note-app','public-model-harness'):path.join(process.env.HOME,'.local','share','note-app','public-model-harness');
const ledger=adapterModule.createFileHarnessLedger(ledgerDirectory);
const adapter=adapterModule.createClaudePublicAdapter(values['claude-path'],cwd,process.env);
let adapterInvocationsThisRun=0;
const harness=harnessModule.createPublicReadingHarness({generate(...args){adapterInvocationsThisRun++;return adapter.generate(...args);}},ledger);
process.once('SIGINT',()=>harness.cancel());process.once('SIGTERM',()=>harness.cancel());
const first=await harness.summarize(pack),before=first.attempts,second=await harness.summarize(pack);
await writeFile(path.join(out,'result.json'),JSON.stringify({sha,inputHash,first,adapterInvocationsThisRun,duplicate:{sameAnswer:JSON.stringify(first)===JSON.stringify(second),additionalCalls:second.attempts-before},billingInterpretation:'Returned usage is observed metadata, not a subscription charge guarantee.'},null,2),{mode:0o600});
console.log(JSON.stringify({stage:'completed',status:first.status,attempts:first.attempts,adapterInvocationsThisRun,errors:first.errors,duplicateAdditionalCalls:second.attempts-before,receipts:first.receipts}));
if(first.status!=='model')process.exitCode=1;
