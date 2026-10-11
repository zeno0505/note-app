import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createLiveFixture} from '../live-fixture/setup.mjs';
export async function createSummaryReviewFixture(){const base=await createLiveFixture(),scope=base.config.noteScopes[0].scopePath;
 const tasks=['T-1','T-2','R-3','T-4','R-5','T-6'].map((id,i)=>({id,title:['검색 목록','원문 이동','검증 기록','결과 없음','키보드 탐색','긴 한국어 태스크 제목으로 줄바꿈과 좁은 화면을 확인합니다'][i],status:i===2?'done':'in_progress',description:'합성 태스크의 범위와 진행 상황입니다.',discussion:[`[[activity-${id}.md]]`],depends_on:[]}));
 for(let i=0;i<4;i++)await writeFile(path.join(scope,`activity-${tasks[i].id}.md`),JSON.stringify({contract:'task-activity-v1',activities:[{taskId:tasks[i].id,kind:i%2?'discussion':'verification',at:`2026-10-09T1${i}:00:00Z`}]}));
 await writeFile(base.dagPath,JSON.stringify({phases:[{id:'summary-ux',tasks}]}));
 base.config.summarySelections=[{scopeId:'fictional-atlas',dagRelativePath:'dag.yaml',taskIds:tasks.map(t=>t.id),excerpts:tasks.slice(0,4).map(t=>({id:'activity-'+t.id,kind:'document',relativePath:`activity-${t.id}.md`,startLine:1,endLine:1}))}];
 await writeFile(base.configPath,JSON.stringify(base.config));
 return {...base,scope,tasks};}
