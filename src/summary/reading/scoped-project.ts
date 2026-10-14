import path from 'node:path';
import {createHash} from 'node:crypto';
import {extractDocumentReferences} from '../../phase2/markdown';
import type {DagReadModel} from '../../facts/dag-read-model/types';
import type {RegisteredExcerptContext} from '../context/registered';
import type {SummaryTaskSelection} from '../../shared/summary-prefix';
export function exactTaskScope(dag:DagReadModel,ids:readonly string[]){
 if(!ids.length||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!dag.tasks.some(t=>t.id===id)))throw Error('Exact task selection unavailable');
 const selected=new Set(ids),tasks=dag.tasks.filter(t=>selected.has(t.id)),index=new Map(dag.tasks.map(t=>[t.id,t]));
 const taskSelection:SummaryTaskSelection={mode:'explicit',taskIds:[...ids].sort(),omittedCount:dag.tasks.length-tasks.length,missingIds:[],reasons:tasks.map(t=>({id:t.id,reason:'명시한 작업 범위',waitingCount:0}))};
 const dependencies=[...new Map(tasks.flatMap(t=>t.dependencies.filter(d=>d.scope==='external'||!selected.has(d.id)).map(d=>[JSON.stringify([d.id,d.scope]),{id:d.id,scope:d.scope,status:d.scope==='internal'?index.get(d.id)?.status??null:null}] as const))).values()];
 const sourceHash='sha256:'+createHash('sha256').update(JSON.stringify({tasks,taskSelection,dependencies,readContractVersion:dag.readContractVersion,policies:dag.policies??[]})).digest('hex');
 return {tasks,taskSelection,dependencies,sourceHash};
}
/** Selection does not grant reads: intersect exact task links with already authorized bounded registrations. */
export function selectedTaskExcerpts(context:RegisteredExcerptContext|undefined,dag:DagReadModel,ids:readonly string[],noteRoot:string):RegisteredExcerptContext|undefined{
 if(!context)return undefined;
 const paths=new Set<string>();for(const task of dag.tasks.filter(t=>ids.includes(t.id)))for(const target of extractDocumentReferences(JSON.stringify(task.details??{})).targets){if(target.kind==='link'&&/\.(md|markdown)$/i.test(target.relativePath))paths.add(path.resolve(noteRoot,target.relativePath));}
 const provenance=context.provenance.filter(p=>/\.(md|markdown)$/i.test(p.registration.relativePath)&&paths.has(p.canonicalPath));
 const allowed=new Set(provenance.map(p=>p.excerptId));return {...context,provenance,excerpts:context.excerpts.filter(e=>allowed.has(e.id))};
}
