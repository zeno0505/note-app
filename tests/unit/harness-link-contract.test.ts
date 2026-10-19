import {describe,it,expect,afterAll} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import fixture from '../../fixtures/harness-v3/link-contract.fixtures.json';
import {resolveHarnessLink,type HarnessFile} from '../../src/phase2/harness-links';
const root=mkdtempSync(join(tmpdir(),'note-harness-link-fixtures-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
// Test-only YAML decoding; not a runtime dependency or document-provided program.
const decode=[
'import json,sys,yaml',
'trees=json.load(sys.stdin)',
'out=[]',
'for tree in trees:',
'    files={}',
'    for name,text in tree.items():',
'        data=None',
'        try:',
'            if name.endswith((".yaml",".yml")): data=yaml.safe_load(text)',
'            elif text.startswith("---\\n"): data=yaml.safe_load(text.split("---",2)[1])',
'        except yaml.YAMLError: pass',
'        files[name]={"text":text,"data":data}',
'    out.append(files)',
'json.dump(out,sys.stdout,default=str)',
].join('\n');
const trees=fixture.cases.map(c=>({...fixture.tree,...('tree_patch' in c?c.tree_patch:{})}));
const snapshots=JSON.parse(execFileSync(process.env.NOTE_APP_CONTRACT_PYTHON??'/usr/local/bin/python3',['-I','-B','-c',decode],{input:JSON.stringify(trees),encoding:'utf8',maxBuffer:4*1024*1024})) as Record<string,HarnessFile>[];
describe('upstream a214e9d link contract (unchanged fixtures)',()=>{
 it('retains exact upstream fixture bytes',()=>{
  expect(createHash('sha256').update(readFileSync(new URL('../../fixtures/harness-v3/link-contract.fixtures.json',import.meta.url))).digest('hex')).toBe('a8e5e3e5d0bd77c2731739794752fb03705d4f83f535395131d109f1421f5d18');
 });
 for(const [i,c] of fixture.cases.entries()) it(c.name,()=>{
  const directory=join(root,String(i));mkdirSync(directory);
  for(const [name,text] of Object.entries(trees[i])){const file=join(directory,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
  const actual=resolveHarnessLink(new Map(Object.entries(snapshots[i])),c.from,c.link);
  expect(actual).toMatchObject(c.expect);
 });
});
