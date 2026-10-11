import {parsePrepareProjectDagRequest} from './project-dag';
import type {ProjectDagCreationPreparation,ProjectDagCreationResult} from './project-dag';
export interface ProjectCreationRequest {draftId:string;expectedDraftRevision:number;projectPath:string;baseBranch:string;verification:string[]}
export interface ProjectCreationBridge {
 getProjectCreationAvailability():Promise<{available:boolean;reason:string}>;
 prepareProjectCreation(request:ProjectCreationRequest):Promise<ProjectDagCreationPreparation>;
 confirmProjectCreation(request:{previewId:string;expectedContentHash:string}):Promise<ProjectDagCreationResult>;
 cancelProjectCreation(request:{previewId:string}):Promise<void>;
}
export function parseProjectCreationRequest(value:unknown):ProjectCreationRequest{
 function fail():never{throw Error('프로젝트 생성 입력을 확인해 주세요.');}
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==5)fail();
 const fields:Record<string,unknown>={};for(const key of ['draftId','expectedDraftRevision','projectPath','baseBranch','verification']){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d))fail();fields[key]=d.value;}const v=fields as unknown as ProjectCreationRequest,id=parsePrepareProjectDagRequest({draftId:v.draftId,expectedDraftRevision:v.expectedDraftRevision});
 if(typeof v.projectPath!=='string'||v.projectPath.length>1024||!v.projectPath.length||v.projectPath.startsWith('/')||v.projectPath.includes('\\')||v.projectPath.split('/').some(x=>!x||x==='.'||x==='..')||/[\u0000-\u001f\u007f]/u.test(v.projectPath))fail();
 if(typeof v.baseBranch!=='string'||!v.baseBranch.length||v.baseBranch.length>256||/[\u0000-\u001f\u007f]/u.test(v.baseBranch))fail();
 const rawVerification=v.verification;
 if(!Array.isArray(rawVerification)||!rawVerification.length||rawVerification.length>32||![Array.prototype,null].includes(Object.getPrototypeOf(rawVerification))||Reflect.ownKeys(rawVerification).length!==rawVerification.length+1)fail();
 const verification=Array.from({length:rawVerification.length},(_,index)=>{const descriptor=Object.getOwnPropertyDescriptor(rawVerification,String(index));if(!descriptor||!('value' in descriptor))fail();const text=descriptor.value;if(typeof text!=='string'||!text.trim()||text.length>2048||/[\u0000-\u001f\u007f]/u.test(text))fail();return text;});
 return {...id,projectPath:v.projectPath,baseBranch:v.baseBranch,verification};
}
