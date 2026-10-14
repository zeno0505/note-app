import {describe,it,expect} from 'vitest';
import {PROJECT_DAG_LIMITS} from '../../src/shared/project-dag';
import {hasProjectCreationChanges,projectCreationFieldError} from '../../src/renderer/project-creation-validation';
const valid={projectPath:'example/demo/project',baseBranch:'main',verification:'npm run typecheck\nnpm test'};
describe('creation form recovery guidance',()=>{
 it('identifies the first missing field in visible form order',()=>{
  expect(projectCreationFieldError({projectPath:'',baseBranch:'',verification:''})?.field).toBe('projectPath');
  expect(projectCreationFieldError({...valid,baseBranch:'',verification:''})?.field).toBe('baseBranch');
  expect(projectCreationFieldError({...valid,verification:' \n '})?.field).toBe('verification');
 });
 it.each(['/absolute/path','../escape','example//project','example/./project','example/../project','example\\project','example/\u0000project','C:drive/project','example/ padded/project','example/ends /project','example/a*b/project'])('explains unsupported path %s',projectPath=>{
  expect(projectCreationFieldError({...valid,projectPath})?.field).toBe('projectPath');
 });
 it.each(['main..other','main.lock','feature/.hidden','@','-main','a//b','main branch','a@{1}','branch~1','a/b.lock','a?b'])('rejects invalid Git branch %s',baseBranch=>{expect(projectCreationFieldError({...valid,baseBranch})?.field).toBe('baseBranch');});
 it('accepts the same trimmed bounded lines sent to the main process',()=>{
  expect(projectCreationFieldError({...valid,projectPath:' example/demo/project ',verification:'\n npm test \n\n npm run check \n'})).toBeNull();
 });
 it('keeps bounded limits explicit',()=>{
  expect(projectCreationFieldError({...valid,baseBranch:'x'.repeat(257)})?.field).toBe('baseBranch');
  expect(projectCreationFieldError({...valid,verification:Array(33).fill('check').join('\n')})?.field).toBe('verification');
  expect(projectCreationFieldError({...valid,verification:'x'.repeat(2049)})?.field).toBe('verification');
  expect(projectCreationFieldError({...valid,verification:Array(32).fill('x'.repeat(2048)).join('\n')})?.field).toBe('verification');
 });
 it('applies the same serialized policy bound, including escapes',()=>{
  const policy=(decision:string[])=>JSON.stringify({key:'verification',decided_at:'2000-01-01',decision,legacy:false});
  const lines=Array(16).fill('x'.repeat(2000));
  while(policy(lines).length<PROJECT_DAG_LIMITS.policyCharacters)lines[15]+='x';
  expect(policy(lines).length).toBe(PROJECT_DAG_LIMITS.policyCharacters);
  // Spread the final characters to respect the independent per-line limit.
  while(lines[15].length>2048){const spare=lines.findIndex(line=>line.length<2048);lines[spare]+='x';lines[15]=lines[15].slice(1);}
  expect(projectCreationFieldError({...valid,verification:lines.join('\n')})).toBeNull();
  lines[lines.findIndex(line=>line.length<2048)]+='x';expect(projectCreationFieldError({...valid,verification:lines.join('\n')})?.field).toBe('verification');
  expect(projectCreationFieldError({...valid,verification:Array(16).fill('\"'.repeat(1100)).join('\n')})?.field).toBe('verification');
 });
});

describe('generation preparation discard detection',()=>{
 it('does not warn for an untouched automatically filled base branch',()=>{expect(hasProjectCreationChanges({projectPath:'',baseBranch:'main',verification:''},'main')).toBe(false);});
 it.each([{projectPath:'example/demo/project',baseBranch:'main',verification:''},{projectPath:'',baseBranch:'develop',verification:''},{projectPath:'',baseBranch:'',verification:''},{projectPath:'',baseBranch:'main',verification:'npm test'},{projectPath:' ',baseBranch:'main',verification:''}])('protects incomplete input %j',input=>{expect(hasProjectCreationChanges(input,'main')).toBe(true);});
});
