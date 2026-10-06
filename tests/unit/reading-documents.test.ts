import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,realpath,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRegisteredExcerptReader} from '../../src/summary/context/registered';
import {observeProjectDocuments,parseProjectDocumentRecord} from '../../src/summary/reading/documents';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const record={schemaVersion:1,id:'feature',section:'implemented',text:'합성 프로젝트의 읽기 화면 코드가 있습니다. 실제 모델 검증은 하지 않았습니다.',verification:null,references:['src/synthetic.ts']};
const registration={id:'feature-doc',kind:'document' as const,relativePath:'record.jsonl',startLine:1,endLine:1};
async function reader(content=JSON.stringify(record)) {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'reading-doc-')));roots.push(root);await writeFile(path.join(root,'record.jsonl'),content);
 return {root,reader:createRegisteredExcerptReader({dagId:'synthetic-dag',canonicalScopePath:root,canonicalNotePath:root,registrations:[registration]})};
}
describe('explicit registered project documents',()=>{
 it('reads one registered record with exact source hash, lines, declaration and reported verification identity',async()=>{
  const data={...record,section:'evidence',verification:{sha:'a'.repeat(40),environment:'synthetic fixture / Linux',result:'passed'}};
  const f=await reader(JSON.stringify(data));const context=await f.reader.read('synthetic-dag');const observed=observeProjectDocuments(context,'synthetic-dag');
  expect(observed).toMatchObject({state:'ready',dagId:'synthetic-dag',records:[{...data,source:{kind:'document',sha:'a'.repeat(40),sourceHash:context.excerpts[0].sourceHash,document:{relativePath:'record.jsonl',lineStart:1,lineEnd:1,environment:'synthetic fixture / Linux',result:'passed'}}}]});
  expect(JSON.stringify(observed)).not.toContain(f.root);
  expect(()=>observeProjectDocuments(context,'another-dag')).toThrow();
  const altered=structuredClone(context);altered.excerpts[0].text='changed';expect(()=>observeProjectDocuments(altered,'synthetic-dag')).toThrow();
 });
 it.each([
  {...record,taskIds:['T-1']},{...record,section:'complete'}, {...record,text:'x'.repeat(1201)},
  {...record,verification:{sha:'unknown',environment:'Mac',result:'passed'}},
  {...record,verification:{sha:'a'.repeat(40),environment:'',result:'passed'}},
  {...record,verification:{sha:'a'.repeat(40),environment:'Mac',result:'approved'}},
  {...record,references:['../private.md']},{...record,references:['/private.md']},
  {...record,references:['a','a']},{...record,references:Array.from({length:7},(_,i)=>String(i))},
 ])('rejects broad, task-completion and incomplete verification metadata %#',value=>expect(()=>parseProjectDocumentRecord(value)).toThrow());
 it('rejects unregistered traversal, symbolic source paths and free-form documents rather than interpreting them',async()=>{
  const f=await reader('A prose document is not an explicit structured record.');
  await expect(f.reader.read('other')).rejects.toThrow();const context=await f.reader.read('synthetic-dag');expect(()=>observeProjectDocuments(context,'synthetic-dag')).toThrow();
  await symlink(path.join(f.root,'record.jsonl'),path.join(f.root,'alias.jsonl'));
  const linked=createRegisteredExcerptReader({dagId:'synthetic-dag',canonicalScopePath:f.root,canonicalNotePath:f.root,registrations:[{...registration,relativePath:'alias.jsonl'}]});await expect(linked.read('synthetic-dag')).rejects.toThrow();
  expect(()=>createRegisteredExcerptReader({dagId:'synthetic-dag',canonicalScopePath:f.root,canonicalNotePath:f.root,registrations:[{...registration,relativePath:'../private.jsonl'}]})).toThrow();
 });
});
