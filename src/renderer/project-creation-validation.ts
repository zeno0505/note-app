import {PROJECT_DAG_LIMITS} from '../shared/project-dag';
/** Local guidance only. The main process remains the authority for every write. */
export interface ProjectCreationFields { projectPath:string; baseBranch:string; verification:string }
export type ProjectCreationField = keyof ProjectCreationFields;
export interface ProjectCreationFieldError { field:ProjectCreationField; message:string }
/** Include incomplete edits: closing must not silently discard what the user typed. */
export function hasProjectCreationChanges(input:ProjectCreationFields,initialBaseBranch:string):boolean {
 return input.projectPath!==''||input.verification!==''||input.baseBranch!==initialBaseBranch;
}
export function projectCreationFieldError(input:ProjectCreationFields):ProjectCreationFieldError|null {
 const projectPath=input.projectPath.trim(),baseBranch=input.baseBranch.trim();
 if(!projectPath)return {field:'projectPath',message:'프로젝트 노트 경로를 입력해 주세요. 예: owner/repository/project-name'};
 if(projectPath.length>PROJECT_DAG_LIMITS.projectPath||projectPath.startsWith('/')||projectPath.includes('\\')||projectPath.split('/').some(part=>!part||part==='.'||part==='..'||part.trim()!==part||/[:*?"<>|]/u.test(part))||/[\u0000-\u001f\u007f]/u.test(projectPath))return {field:'projectPath',message:'프로젝트 노트 경로는 상대 경로로 입력해 주세요. /로 시작하거나 빈 구간, . 또는 .., 구간 앞뒤 공백이나 : * ? " < > | 문자를 포함할 수 없습니다.'};
 if(!baseBranch)return {field:'baseBranch',message:'확인할 기존 로컬 Git 기준 브랜치를 입력해 주세요.'};
 if(baseBranch.length>PROJECT_DAG_LIMITS.branch||/[\u0000-\u001f\u007f]/u.test(baseBranch))return {field:'baseBranch',message:'기준 브랜치를 256자 이내의 한 줄로 입력해 주세요.'};
 if(baseBranch==='@'||baseBranch.startsWith('-')||baseBranch.startsWith('/')||baseBranch.endsWith('/')||baseBranch.endsWith('.')||baseBranch.includes('..')||baseBranch.includes('@{')||/[ ~^:?*\[\\]/u.test(baseBranch)||baseBranch.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))return {field:'baseBranch',message:'Git 기준 브랜치 이름을 확인해 주세요. 공백, .., .lock으로 끝나는 구간 등은 사용할 수 없습니다.'};
 const verification=input.verification.split('\n').map(line=>line.trim()).filter(Boolean);
 if(!verification.length)return {field:'verification',message:'검증 지침을 한 줄 이상 입력해 주세요. 명령이나 확인 절차를 기록만 하며 실행하지 않습니다.'};
 if(verification.length>PROJECT_DAG_LIMITS.verificationCount||verification.some(line=>line.length>PROJECT_DAG_LIMITS.verificationInstruction||/[\u0000-\u001f\u007f]/u.test(line)))return {field:'verification',message:'검증 지침은 32줄 이하, 한 줄당 2,048자 이내로 입력해 주세요.'};
 // decided_at always has exactly ten characters in the authoritative policy.
 const policy={key:'verification',decided_at:'2000-01-01',decision:verification,legacy:false};
 if(JSON.stringify(policy).length>PROJECT_DAG_LIMITS.policyCharacters)return {field:'verification',message:'검증 지침 전체가 저장 형식의 크기 제한을 넘습니다. 내용을 줄여 주세요. 따옴표·역슬래시 등도 길이에 포함됩니다.'};
 return null;
}
