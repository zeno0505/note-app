import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readRegisteredHarnessSnapshot} from '../../src/main/phase4/harness-references';
import {createDescriptorMetadataTransport,type DescriptorMetadataTransport} from '../../src/main/phase4/descriptor-metadata';
const roots:string[]=[],transports:DescriptorMetadataTransport[]=[];
afterEach(async()=>{for(const transport of transports.splice(0)){transport.dispose();await transport.settle();}for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(schema='3'){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'harness-scope-')));roots.push(root);
 await fs.writeFile(path.join(root,'dag.yaml'),'schema: '+schema+'\nledger_key: MIG.DEV\nphases:\n- tasks:\n  - id: MIG.DEV-0001\n    acceptance: [{id: AC-1}]\n');
 await fs.writeFile(path.join(root,'dag.md'),'# MIG.DEV-0001\n');
 await fs.mkdir(path.join(root,'inbox'));
 await fs.writeFile(path.join(root,'inbox','origin.md'),'[[dag#MIG.DEV-0001]]');
 await fs.writeFile(path.join(root,'inbox','plan.md'),'---\nid: MIG.DEV-0001.plan\n---\n# Plan');
 const metadata=createDescriptorMetadataTransport({pythonPath:process.env.DAG_QUERY_PYTHON||'/usr/local/bin/python3'});transports.push(metadata);
 return {root,metadata,from:'inbox/origin.md',authorize:async()=>true,signal:new AbortController().signal};
}
it('resolves task, AC and document IDs only inside an authorized root',async()=>{
 const options=await fixture(),snapshot=await readRegisteredHarnessSnapshot(options);
 expect(snapshot.enabled).toBe(true);expect(snapshot.omissions).toEqual([]);
 const task=snapshot.resolve('[[dag#MIG.DEV-0001]]');expect(task.result).toBe('resolved');expect(snapshot.document(task)).toEqual({relativePath:'dag.md',anchor:'MIG.DEV-0001'});
 expect(snapshot.resolve('[[dag#MIG.DEV-0001/AC-1]]')).toMatchObject({result:'resolved',target:{ac:'AC-1'}});
 expect(snapshot.document(snapshot.resolve('[[MIG.DEV-0001.plan]]'))).toEqual({relativePath:'inbox/plan.md',anchor:null});
 expect(snapshot.resolve('[[../../outside.md]]').result).toBe('out-of-scope');
});
it('keeps old schema 2 caller behavior',async()=>expect((await readRegisteredHarnessSnapshot(await fixture('2'))).enabled).toBe(false));
it.each(['"3"','99'])('does not fall back to legacy resolution for unsupported schema %s',async schema=>{
 const snapshot=await readRegisteredHarnessSnapshot(await fixture(schema));expect(snapshot.enabled).toBe(true);expect(snapshot.resolve('[[dag#MIG.DEV-0001]]').result).toBe('unsupported');
});
it('preserves denied separately from unsupported and absence',async()=>{
 const options=await fixture(),snapshot=await readRegisteredHarnessSnapshot({...options,authorize:async()=>false});
 expect(snapshot.enabled).toBe(true);expect(snapshot.resolve('[[dag#MIG.DEV-0001]]').result).toBe('denied');
});
it('does not follow symlinks or certify uniqueness from an incomplete index',async()=>{
 const options=await fixture();await fs.symlink('/tmp',path.join(options.root,'outside'));
 const snapshot=await readRegisteredHarnessSnapshot(options);expect(snapshot.resolve('[[unknown]]')).toMatchObject({result:'unsupported',warnings:['snapshot-incomplete']});
});
it('does not search an ancestor ledger when the nearest ledger is malformed',async()=>{
 const options=await fixture();await fs.writeFile(path.join(options.root,'inbox','dag.yaml'),'schema: [');
 const snapshot=await readRegisteredHarnessSnapshot(options);expect(snapshot.enabled).toBe(true);expect(snapshot.resolve('[[dag#MIG.DEV-0001]]').result).toBe('unsupported');
});
it('cancels before traversing files',async()=>{
 const options=await fixture(),controller=new AbortController();controller.abort();
 await expect(readRegisteredHarnessSnapshot({...options,signal:controller.signal})).rejects.toThrow('cancelled');
});
it('resolves child-ledger tasks when the source is outside any ledger',async()=>{
 const options=await fixture();await fs.mkdir(path.join(options.root,'MIG.QA'));
 await fs.rename(path.join(options.root,'dag.yaml'),path.join(options.root,'MIG.QA','dag.yaml'));
 await fs.writeFile(path.join(options.root,'README.md'),'[[MIG.QA/dag#MIG.DEV-0001]]');
 const snapshot=await readRegisteredHarnessSnapshot({...options,from:'README.md'});
 expect(snapshot.enabled).toBe(true);expect(snapshot.resolve('[[MIG.QA/dag#MIG.DEV-0001]]')).toMatchObject({result:'resolved',target:{task:'MIG.DEV-0001'}});
});
it.each(['99','"3"'])('rejects a descendant target ledger with unsupported schema %s',async schema=>{
 const options=await fixture();await fs.mkdir(path.join(options.root,'child'));
 await fs.rename(path.join(options.root,'dag.yaml'),path.join(options.root,'child','dag.yaml'));
 await fs.writeFile(path.join(options.root,'child','dag.yaml'),'schema: '+schema+'\nledger_key: CHILD\nphases: [{tasks: [{id: CHILD-0001}]}]');
 const snapshot=await readRegisteredHarnessSnapshot({...options,from:'README.md'});
 expect(snapshot.resolve('[[child/dag#CHILD-0001]]')).toMatchObject({result:'unsupported',warnings:['unsupported-schema']});
});
it('does not activate v3 mode from an unrelated settings YAML',async()=>{
 const options=await fixture();await fs.rm(path.join(options.root,'dag.yaml'));
 await fs.writeFile(path.join(options.root,'settings.yaml'),'schema: 3');
 const snapshot=await readRegisteredHarnessSnapshot({...options,from:'README.md'});expect(snapshot.enabled).toBe(false);
});
it.each([true,false])('checks target schema before task presence independently of ledger_key (%s)',async key=>{
 const options=await fixture();await fs.mkdir(path.join(options.root,'child'));await fs.writeFile(path.join(options.root,'child','dag.yaml'),'schema: 99\n'+(key?'ledger_key: CHILD\n':'')+'phases: [{tasks: [{id: CHILD-0001}]}]');
 const snapshot=await readRegisteredHarnessSnapshot({...options,from:'README.md'});
 for(const id of ['CHILD-0001','DOES-NOT-EXIST'])expect(snapshot.resolve('[[child/dag#'+id+']]')).toMatchObject({result:'unsupported',warnings:['unsupported-schema']});
});
it('exposes owned evidence reads to the existing update cleanup owner',async()=>{
 const options=await fixture(),results:boolean[]=[];
 const snapshot=await readRegisteredHarnessSnapshot({...options,trackRead:async operation=>{const result=await operation();results.push(result.ok);return result;}});
 expect(snapshot.resolve('[[dag#MIG.DEV-0001]]').result).toBe('resolved');expect(results.length).toBeGreaterThan(1);expect(results.every(Boolean)).toBe(true);
});
