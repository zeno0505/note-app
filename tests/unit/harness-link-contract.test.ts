import {describe,it,expect,afterAll} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {harnessFile} from '../../src/phase2/harness-yaml';
import fixture from '../../fixtures/harness-v3/link-contract.fixtures.json';
import {resolveHarnessLink} from '../../src/phase2/harness-links';
const root=mkdtempSync(join(tmpdir(),'note-harness-link-fixtures-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const trees=fixture.cases.map(c=>({...fixture.tree,...('tree_patch' in c?c.tree_patch:{})}));
describe('upstream a214e9d link contract (unchanged fixtures)',()=>{
 it('retains exact upstream fixture bytes',()=>{
  expect(createHash('sha256').update(readFileSync(new URL('../../fixtures/harness-v3/link-contract.fixtures.json',import.meta.url))).digest('hex')).toBe('a8e5e3e5d0bd77c2731739794752fb03705d4f83f535395131d109f1421f5d18');
 });
 for(const [i,c] of fixture.cases.entries()) it(c.name,()=>{
  const directory=join(root,String(i));mkdirSync(directory);
  for(const [name,text] of Object.entries(trees[i])){const file=join(directory,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
  const actual=resolveHarnessLink(new Map(Object.entries(trees[i]).map(([name,text])=>[name,harnessFile(readFileSync(join(directory,name),'utf8'),name)])),c.from,c.link);
  expect(actual).toMatchObject(c.expect);
 });
});
