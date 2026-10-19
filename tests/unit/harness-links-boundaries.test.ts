import {describe,it,expect} from 'vitest';
import {resolveHarnessLink} from '../../src/phase2/harness-links';
const files=(legacy='old/dag.yaml@abcdef0#T-1')=>new Map([
 ['MIG.DEV/dag.yaml',{text:'',data:{ledger_key:'MIG.DEV',phases:[{tasks:[{id:'MIG.DEV-0001',legacy_ref:legacy}]}]}}],
 ['MIG.DEV/inbox/plan.md',{text:''}],
]);
describe('harness resolver contract boundaries',()=>{
 it('does not treat an uppercase legacy DAG path as a task reference',()=>{
  expect(resolveHarnessLink(files('old/DAG.YAML@abcdef0#T-1'),'MIG.DEV/inbox/plan.md','[[dag#T-1]]').result).toBe('missing');
 });
 it('keeps commit hex case independent of case-sensitive paths',()=>{
  expect(resolveHarnessLink(files('old/dag.yaml@ABCDEF0#T-1'),'MIG.DEV/inbox/plan.md','[[dag#T-1]]')).toMatchObject({result:'resolved',target:{via:'legacy_ref'}});
 });
 it('offers a case hint without resolving a differently cased task ID',()=>{
  expect(resolveHarnessLink(files(),'MIG.DEV/inbox/plan.md','[[dag#mig.dev-0001]]')).toMatchObject({result:'missing',hint:['MIG.DEV-0001']});
 });
 it.each(['[[/etc/hosts]]','[[../../outside]]','[[%2Fetc%2Fhosts]]'])('never hides an absolute or escaping path behind the ledger root: %s',link=>{
  expect(resolveHarnessLink(files(),'MIG.DEV/inbox/plan.md',link).result).toBe('out-of-scope');
 });
 it.each(['[[run:evil.sh]]','https://evil.example/blob/abcdef0/a.md','[[dag#%00x]]'])('rejects executable, foreign URL and control inputs: %s',link=>{
  expect(resolveHarnessLink(files(),'MIG.DEV/inbox/plan.md',link).result).toBe('unsupported');
 });
});
