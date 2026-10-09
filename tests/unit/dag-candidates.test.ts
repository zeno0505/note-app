import {it,expect} from 'vitest';
import {mkdtemp,realpath,writeFile,symlink,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {createDagCandidateScanner} from '../../src/main/dag-candidates';
const pythonPath=process.env.DAG_QUERY_PYTHON,queryScriptPath=process.env.DAG_QUERY_SCRIPT;
it.skipIf(!pythonPath||!queryScriptPath)('lists only verified DAG files in the selected directory, excluding arbitrary YAML and symlinks',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'dag-candidates-')));
 try{
  await writeFile(path.join(root,'dag.yaml'),'phases: []');await writeFile(path.join(root,'back-dag.yaml'),JSON.stringify({phases:[{tasks:[{id:'T-fixture',status:'pending'}]}]}));await writeFile(path.join(root,'settings.yaml'),'settings: true');await writeFile(path.join(root,'malformed.yaml'),'phases: [broken');await symlink(path.join(root,'dag.yaml'),path.join(root,'link.yaml'));await mkdir(path.join(root,'nested'));await writeFile(path.join(root,'nested/other.yaml'),'phases: []');
  const result=await createDagCandidateScanner({pythonPath:pythonPath!,queryScriptPath:queryScriptPath!})(root);expect(result.candidates.map(c=>c.relativePath)).toEqual(['back-dag.yaml','dag.yaml']);expect(result.candidates.map(c=>c.taskCount)).toEqual([1,0]);expect(result.excludedCount).toBe(3);expect(result.excluded).toContainEqual({relativePath:'settings.yaml',reason:'document_shape_invalid'});expect(result.excluded).toContainEqual({relativePath:'link.yaml',reason:'unsafe_file'});expect(JSON.stringify(result.candidates.map(({id,relativePath,taskCount})=>({id,relativePath,taskCount})))).not.toContain(root);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('bounds directory enumeration without executing a query',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'dag-candidate-limit-')));
 try{await Promise.all(Array.from({length:17},(_,i)=>writeFile(path.join(root,`fixture-${i}.yaml`),'phases: []')));await expect(createDagCandidateScanner({pythonPath:'/never-executed',queryScriptPath:'/never-executed'})(root)).rejects.toThrow('16개');}finally{await rm(root,{recursive:true,force:true});}
});

it.skipIf(!pythonPath||!queryScriptPath)('retains valid DAGs above 2MiB and rejects files above the existing 16MiB source budget',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'dag-candidate-size-')));
 try{
  await writeFile(path.join(root,'dag.yaml'),JSON.stringify({phases:[{tasks:Array.from({length:459},(_,i)=>({id:'T-'+i,status:'pending'}))}],privateFixturePadding:'x'.repeat(2*1024*1024)}));
  await writeFile(path.join(root,'too-large.yaml'),'phases: []\n#'+ 'x'.repeat(16*1024*1024));
  const result=await createDagCandidateScanner({pythonPath:pythonPath!,queryScriptPath:queryScriptPath!})(root);expect(result.candidates.map(c=>[c.relativePath,c.taskCount])).toEqual([['dag.yaml',459]]);expect(result.excluded).toEqual([{relativePath:'too-large.yaml',reason:'source_limit'}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
