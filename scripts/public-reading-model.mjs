import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{output:{type:'string'},execute:{type:'boolean',default:false},'approved-public-sha':{type:'string'},'claude-path':{type:'string'},'cached-only':{type:'boolean',default:false}}});
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
const usage=excerpt('src/renderer/routes.ts',"path:'/usage'",4);
const manual=excerpt('docs/plans/project-model-reading-integration.md','2026-10-06 사용자는',3);
const phase2=excerpt('docs/plans/phase2-task-scope.md','| T-029',4);
const mac=excerpt('reviews/usage-statistics-mac.md','## 구현과 검증',16);
const response=await fetch('https://api.github.com/repos/zeno0505/note-app/actions/runs?head_sha='+sha+'&per_page=5');if(!response.ok)throw Error('Public CI query unavailable; no model call');
const data=await response.json(),runs=data.workflow_runs.map(r=>({id:r.id,head_sha:r.head_sha,event:r.event,status:r.status,conclusion:r.conclusion,html_url:r.html_url}));if(!runs.length||runs.some(r=>r.head_sha!==sha))throw Error('Missing exact-SHA public CI');
const ciText=JSON.stringify({headSha:sha,runs});const ci='S'+(sources.length+1);sources.push({id:ci,path:'.github/workflows/check.yml#public-actions-observation',lineStart:1,lineEnd:1,sha256:createHash('sha256').update(ciText).digest('hex'),excerpt:ciText});
const success=runs.every(r=>r.status==='completed'&&r.conclusion==='success');
const facts=[
 {id:'F1',section:'implemented',state:'known',text:'프로젝트 목록의 요약을 분리하고 선택한 프로젝트 요약을 별도 영역에 표시하는 UI가 소스에 구현되어 있습니다.',sourceIds:[list],anchors:['목록','선택','요약']},
 {id:'F2',section:'implemented',state:'none',text:'일반 앱의 지금 요약은 전체 설정 소스를 새로 읽는 규칙 기반 갱신입니다. 기존 production 모델 실행은 차단되어 있고 자동 모델 호출은 없습니다.',sourceIds:[rules,blocked,summaryAction],anchors:['규칙 기반','전체','자동 모델 호출','없']},
 {id:'F3',section:'next',state:'known',text:'Phase 2의 계정 한도와 메모리 기반 동시 실행 제어, T-029 자원 정책·T-030 개발 위임·T-031 DAG 갱신 제안·T-032 트레이 최근 프로젝트는 계획 태스크입니다. 이번 공개 입력은 실제 구현을 입증하지 않습니다. 다른 note 프로젝트 모델 연결은 선행 실험 평가 뒤 점진 적용할 후속 작업입니다.',sourceIds:[planning,phase2,manual],anchors:['계정','메모리','계획','입증하지','T-029','T-030','T-031','T-032','평가']},
 {id:'F4',section:'evidence',state:'known',text:`공개 소스 SHA ${sha}의 CI 조회 결과는 ${success?'성공':'성공 미확인'}입니다. workflow 환경은 Ubuntu 24.04, Node 24.19.0이며 타입 검사·단위 테스트·빌드를 실행합니다.`,sourceIds:[workflow,ci],anchors:[sha,success?'성공':'미확인','24.04','24.19.0','타입','테스트','빌드']},
 {id:'F5',section:'evidence',state:'none',text:'CI 성공은 Mac GUI 검수와 별개입니다. Mac 근거는 별도 검증 기록에 있고 배포 완료를 입증하지 않습니다. PR 병합도 테스트나 배포와 별개이며 Phase 1 전체 완료로 확대하지 않습니다.',sourceIds:[workflow,mac],anchors:['Mac','배포','PR','별개','Phase 1','전체']},
 {id:'F6',section:'decisions',state:'unrecorded',text:'일반 읽기 요약에서 프로젝트별 설계 상태는 미기재입니다. 미기재를 결정 사항 없음이나 설계 완료로 바꾸지 않습니다. 다른 프로젝트 모델 전송 대상·권한·자동 실행 경계는 이번 공개 실험 뒤 별도 확인해야 합니다.',sourceIds:[reading,manual],anchors:['설계','미기재','없음','전송','확인']},
 {id:'F7',section:'implemented',state:'known',text:'CodeBurn 사용량 통계를 독립 /usage 경로로 분리하고 프로젝트 현황의 중복 패널을 제거했습니다. 실제 페이지 이동과 좁은 화면 검증 기록이 있지만 T-028 원래 의존성/수용기준을 무시해 전체 완료로 바꾸지 않습니다.',sourceIds:[usage,mac],anchors:['CodeBurn','/usage','분리','중복','T-028','전체 완료']},
 {id:'F8',section:'evidence',state:'known',text:'공개 Mac 검증 기록에는 제품 source SHA 7b0f42d90c1d51257db2afa503c148e7765bfb2d, 941개 단위 통과·16개 skip, 타입/빌드 통과와 실제 Orca 74개 작업·CodeBurn status/quota 성공이 있습니다. 입력 SHA와 실제 실행 앱 SHA는 같은 개념이 아니며 현재 앱 전체를 추정하지 않습니다.',sourceIds:[mac],anchors:['7b0f42d90c1d51257db2afa503c148e7765bfb2d','941','16','74','입력','앱 SHA']},
 {id:'F9',section:'decisions',state:'known',text:'2026-10-06 공개 note-app 선별 근거만 기존 Claude 구독으로 수동 선행 실험하는 정책이 승인됐습니다. 동시 1개, 생성 1회·검증 실패 수정 최대 1회, 동일 입력 재호출 0, 최신 성공 본문 1개를 유지합니다. 구현 진행과 승인 사실은 실험 내용 정확성이나 일반 자동 실행의 완료가 아닙니다.',sourceIds:[manual],anchors:['2026-10-06','Claude','수동','승인','동시 1','생성 1','최대 1','재호출 0','정확성','자동']},
];
const pack={project:'zeno0505/note-app',sourceSha:sha,sources,facts};
await build({entryPoints:['src/summary/reading/model-harness.ts','src/summary/reading/claude-public-adapter.ts','src/summary/reading/model-reading-storage.ts'],outdir:path.join(out,'compiled'),platform:'node',format:'esm',bundle:true,target:'node24'});
const harnessModule=await import(pathToFileURL(path.join(out,'compiled/model-harness.js'))),adapterModule=await import(pathToFileURL(path.join(out,'compiled/claude-public-adapter.js')));
const inputHash=harnessModule.publicInputHash(pack);await writeFile(path.join(out,'public-evidence-pack.json'),JSON.stringify({inputHash,pack},null,2),{mode:0o600});
console.log(JSON.stringify({stage:'prepared',sha,inputHash,sourceCount:sources.length,facts:facts.length,bytes:Buffer.byteLength(JSON.stringify(pack)),publicOnly:true,execute:values.execute}));
if(!values.execute)process.exit(0);
if(!values['claude-path']||!path.isAbsolute(values['claude-path']))throw Error('Explicit installed Claude executable required');
const cwd=path.join(out,'empty-workspace');await mkdir(cwd,{mode:0o700,recursive:true});
// Every experiment directory shares one durable per-user reservation/lock.
// Changing --output must not create another paid-call allowance.
const ledgerDirectory=process.platform==='darwin'?path.join(process.env.HOME,'Library','Application Support','note-app','model-reading'):path.join(process.env.HOME,'.local','share','note-app','model-reading');
const storageModule=await import(pathToFileURL(path.join(out,'compiled/model-reading-storage.js')));
const ledger=storageModule.createModelReadingStorage(ledgerDirectory).ledger(pack);
const adapter=values['cached-only']?{generate:async()=>{throw Error('Cached-only invocation cannot call a model');}}:adapterModule.createClaudePublicAdapter(values['claude-path'],cwd,process.env);
let adapterInvocationsThisRun=0;
const harness=harnessModule.createPublicReadingHarness({generate(...args){adapterInvocationsThisRun++;return adapter.generate(...args);}},ledger);
process.once('SIGINT',()=>harness.cancel());process.once('SIGTERM',()=>harness.cancel());
const first=await harness.summarize(pack),before=first.attempts,second=await harness.summarize(pack);
await writeFile(path.join(out,'result.json'),JSON.stringify({sha,inputHash,first,adapterInvocationsThisRun,duplicate:{sameAnswer:JSON.stringify(first.answer)===JSON.stringify(second.answer),additionalCalls:second.attempts-before},billingInterpretation:'Returned usage is observed metadata, not a subscription charge guarantee.'},null,2),{mode:0o600});
console.log(JSON.stringify({stage:'completed',status:first.status,attempts:first.attempts,adapterInvocationsThisRun,errors:first.errors,duplicateAdditionalCalls:second.attempts-before,receipts:first.receipts}));
if(first.status!=='model')process.exitCode=1;
