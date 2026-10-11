import {it,expect,vi} from 'vitest';
import {mkdtemp,realpath,rm,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import compiled from '../../src/shared/public-reading-pack.json';
import review from '../../src/shared/public-model-review.json';
import {publicInputHash,validateModelAnswer,SECTION_IDS,type PublicReadingPack,type ModelAdapter} from '../../src/summary/reading/model-harness';
import {createPublicModelController} from '../../src/main/public-model';
import {createModelReadingStorage} from '../../src/summary/reading/model-reading-storage';

it('ships a self-consistent synthetic public fixture with exact public-document excerpts',async()=>{
  const pack=compiled as PublicReadingPack;
  expect(pack.sourceSha).toBe('0'.repeat(40));
  expect(publicInputHash(pack)).toBe(review.inputHash);
  expect(review.sourceSha).toBe(pack.sourceSha);
  expect(review.kind).toBe('synthetic-public-model-example');
  expect(review.provider).toBe('synthetic-fixture');
  expect(review.manualReview.note).toContain('합성 예제');
  for(const source of pack.sources){
    expect(source.path).toBe('docs/synthetic-public-reading.md');
    const lines=(await readFile(source.path,'utf8')).split('\n');
    expect(lines.slice(source.lineStart-1,source.lineEnd).join('\n')).toBe(source.excerpt);
    expect(createHash('sha256').update(source.excerpt).digest('hex')).toBe(source.sha256);
  }
  for(const fact of pack.facts){expect(fact.state).toBe('unrecorded');expect(fact.text).toContain('합성 예제');}
  const binding={runId:review.runId,project:pack.project,inputHash:review.inputHash,version:review.version,attempt:1 as const};
  expect(validateModelAnswer({...binding,sections:review.sections},binding,pack)).toEqual([]);
});

async function treeBytes(directory:string):Promise<Record<string,string>>{
  const result:Record<string,string>={};
  async function visit(at:string){for(const item of await readdir(at,{withFileTypes:true})){
    const full=path.join(at,item.name);
    if(item.isDirectory())await visit(full);
    else result[path.relative(directory,full)]=(await readFile(full)).toString('base64');
  }}
  await visit(directory);return result;
}

it('synthetic view/run/cancel creates no ledger or provider call and leaves a missing cache absent',async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'public-synthetic-empty-')));
  try{
    const storage=createModelReadingStorage(path.join(root,'model-reading'));
    const ledger=vi.spyOn(storage,'ledger'),generate=vi.fn();
    const controller=createPublicModelController(compiled as PublicReadingPack,storage,{generate});
    for(const view of [await controller.view(),await controller.run(),await controller.cancel()]){
      expect(view.state).toBe('disabled');expect(view.message).toContain('합성 예제');expect(view.latest.state).toBe('empty');
    }
    controller.dispose();await controller.settle();
    expect(generate).not.toHaveBeenCalled();expect(ledger).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([]);
  }finally{await rm(root,{recursive:true,force:true});}
});

it('synthetic public input preserves an existing successful cache and ledger byte for byte as stale',async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'public-synthetic-stale-')));
  try{
    const storage=createModelReadingStorage(path.join(root,'model-reading'));
    const older=structuredClone(compiled) as PublicReadingPack;older.sourceSha='a'.repeat(40);
    const priorAdapter:ModelAdapter={generate:async({binding,pack})=>({answer:{...binding,sections:SECTION_IDS.map(id=>({id,text:pack.facts.filter(f=>f.section===id).map(f=>f.text).join(' '),facts:pack.facts.filter(f=>f.section===id).map(f=>({id:f.id,state:f.state})),sourceIds:[...new Set(pack.facts.filter(f=>f.section===id).flatMap(f=>f.sourceIds))]}))},provider:'synthetic-fixture',runtimeMs:1,usage:{}})};
    await createPublicModelController(older,storage,priorAdapter).run();
    const prior=await storage.readLatest(older.project);expect(prior.state).toBe('ready');
    const before=await treeBytes(root),ledger=vi.spyOn(storage,'ledger'),generate=vi.fn();
    const controller=createPublicModelController(compiled as PublicReadingPack,storage,{generate});
    for(const view of [await controller.view(),await controller.run(),await controller.cancel()]){
      expect(view.state).toBe('disabled');expect(view.latest.state).toBe('stale');
      expect('latest' in view.latest&&view.latest.latest).toEqual('latest' in prior&&prior.latest);
    }
    controller.dispose();await controller.settle();
    expect(generate).not.toHaveBeenCalled();expect(ledger).not.toHaveBeenCalled();expect(await treeBytes(root)).toEqual(before);
  }finally{await rm(root,{recursive:true,force:true});}
});
