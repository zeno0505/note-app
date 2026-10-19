import {describe,it,expect} from 'vitest';
import {projectHarnessDeclarations,type HarnessTaskDeclaration} from '../../src/phase2/harness-ledger';
const task=()=>[{id:'MIG.DEV-0001',harness:undefined as HarnessTaskDeclaration|undefined}];
const wire=(schema:unknown=3)=>({ledger:{schema,profile:'v3',features:[],ledger_key:'MIG.DEV'},ledgerTasks:[{id:'MIG.DEV-0001',acceptance:[{id:'AC-1',verify_by:[{repo:'a',path:'test.py'},{repo:'b',path:'test.py'}],block:{reason:'needs_input',who:'zeno',question:'q'},exception:{reason_ref:'original'}}],judgment:{leaf:'machine',verdict:'met'},verification:[{kind:'fixed',observes:['AC-1'],verdict:'unobserved',grade:'실행 관측',env:{target:{repo:'p'},via:{runner:'r'}}}],who:'zeno',question:'q'}]});
describe('mixed harness declaration projection',()=>{
 it.each([2,3])('uses numeric schema %s without promoting absent declarations',schema=>{
  const tasks=task(),raw=wire(schema);const h=projectHarnessDeclarations(raw,tasks);
  expect(h?.state).toBe('supported');expect(h?.schema).toBe(schema);
  if(schema===2)expect(tasks[0].harness).toBeUndefined();
 });
 it.each(['3',1,4,'future',true,false,{},[]].map(schema=>[schema]))('preserves unsupported format %s without accepting it as schema 3',schema=>{
  const tasks=task();expect(projectHarnessDeclarations(wire(schema),tasks)?.state).toBe('unsupported-format');expect(tasks[0].harness).toBeUndefined();
 });
 it('does not guess a missing schema',()=>{
  expect(projectHarnessDeclarations(wire(null),task())?.state).toBe('schema-missing');
 });
 it('keeps schema 2 transitional fields when the profile explicitly declares them',()=>{
  const raw=wire(2);raw.ledger.profile='v2+v3-fields';const tasks=task();projectHarnessDeclarations(raw,tasks);expect(tasks[0].harness?.acceptance).toHaveLength(1);
 });
 it('treats features as hints and records unknown features and actual fields separately',()=>{
  const raw=wire();raw.ledger.features=['future-feature'] as never;
  const h=projectHarnessDeclarations(raw,task());
  expect(h).toMatchObject({features:['future-feature'],unsupportedFeatures:['future-feature'],observedFeatures:expect.arrayContaining(['acceptance','verification'])});
 });
 it('never upgrades met, exceptions or an execution record into authenticated success',()=>{
  const raw=wire(),tasks=task();projectHarnessDeclarations(raw,tasks);
  expect(tasks[0].harness).toMatchObject({judgment:{verdict:'met'},verification:[{verdict:'unobserved'}],verificationState:'검사 결과 연결 미확인'});
  expect(tasks[0].harness?.acceptance[0]).toHaveProperty('exception.reason_ref','original');
 });
 it('detaches declarations and records malformed and over-limit fields',()=>{
  const raw=wire(),tasks=task();raw.ledgerTasks[0].acceptance.push(null as never);
  projectHarnessDeclarations(raw,tasks);raw.ledgerTasks[0].judgment.verdict='not_met';
  expect(tasks[0].harness?.judgment?.verdict).toBe('met');expect(tasks[0].harness?.omissions).toBe(1);
 });
 it('rejects mismatched task bindings',()=>{
  const raw=wire();raw.ledgerTasks[0].id='OTHER-0001';expect(()=>projectHarnessDeclarations(raw,task())).toThrow('binding');
 });
 it('does not change older wire contracts without ledger metadata',()=>{
  expect(projectHarnessDeclarations({},task())).toBeUndefined();
 });
});
