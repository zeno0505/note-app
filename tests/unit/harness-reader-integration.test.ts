import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {HARNESS_QUERY_SHA256} from '../../src/facts/dag-read-model/process';
import {describe,it,expect} from 'vitest';
import {mkdtemp,copyFile,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDagReader} from '../../src/facts/dag-read-model';
const python=process.env.DAG_QUERY_PYTHON,query=process.env.DAG_QUERY_SCRIPT;
describe.skipIf(!python||!query||createHash('sha256').update(readFileSync(query)).digest('hex')!==HARNESS_QUERY_SHA256)('harness v3 real pinned query transport (synthetic YAML)',()=>{
 it('reads original v3 fixture through the actual Python loader without certifying execution',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'note-harness-reader-'))),source=join(directory,'dag.yaml');
  try{
   await copyFile(new URL('../../fixtures/harness-v3/render-v3-dag.yaml',import.meta.url),source);
   const result=await createDagReader({pythonPath:python!,queryScriptPath:query!,registrations:[{dagId:'fixture',canonicalDagPath:source}],timeoutMs:10000}).read('fixture');
   expect(result.ok).toBe(true);
   if(!result.ok)throw Error(result.error.kind);
   expect(result.value.ledger).toMatchObject({schema:3,state:'supported'});
   expect(result.value.tasks.some(t=>t.harness?.acceptance.length)).toBe(true);
   expect(result.value.tasks.every(t=>!t.harness||t.harness.verificationState==='검사 결과 연결 미확인')).toBe(true);
   expect(result.value.verifiedFacts).toEqual([]);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it.each(['"3"','99'])('surfaces unsupported schema %s through the real transport',async schema=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'note-harness-schema-'))),source=join(directory,'dag.yaml');
  try{
   const raw=await readFile(new URL('../../fixtures/harness-v3/render-v3-dag.yaml',import.meta.url),'utf8');
   await writeFile(source,raw.replace(/^schema: 3/m,'schema: '+schema));
   const result=await createDagReader({pythonPath:python!,queryScriptPath:query!,registrations:[{dagId:'fixture',canonicalDagPath:source}],timeoutMs:10000}).read('fixture');
   expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.kind);
   expect(result.value.ledger?.state).toBe('unsupported-format');
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});
