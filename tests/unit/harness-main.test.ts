import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {observeHarnessMain} from '../../src/main/harness-main';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'harness-main-')));roots.push(root);
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','Synthetic Test');git('config','user.email','test@example.invalid');
 await fs.writeFile(path.join(root,'dag.yaml'),'schema: 3\nledger_key: TEST\nphases:\n- tasks:\n  - id: TEST-0001\n    title: committed\n    status: done\n    acceptance: [{id: AC-1, expect: original}]\n');
 git('add','dag.yaml');git('commit','-m','synthetic main');const commit=git('rev-parse','HEAD');
 git('checkout','-b','session');await fs.writeFile(path.join(root,'dag.yaml'),'schema: 3\nphases: []\n');
 return {root,git,commit,options:{roots:[root],dagPath:path.join(root,'dag.yaml'),gitExecutable:'/usr/bin/git',allowedCommonGitDirs:[],authorize:async()=>true,signal:new AbortController().signal}};
}
it('observes exact committed main independently of dirty session without changing either',async()=>{
 const f=await fixture(),before=f.git('status','--porcelain=v1'),result=await observeHarnessMain(f.options);
 expect(result.state).toBe('observed');if(result.state!=='observed')throw Error(result.reason);
 expect(result.commit).toBe(f.commit);expect(result.tasks[0]).toMatchObject({id:'TEST-0001',title:'committed',status:'done',harness:{acceptance:[{id:'AC-1'}],verificationState:'검사 결과 연결 미확인'}});
 expect(f.git('symbolic-ref','--short','HEAD')).toBe('session');expect(f.git('status','--porcelain=v1')).toBe(before);
});
it('does not read unapproved parent repositories or Git configuration',async()=>{
 const f=await fixture(),result=await observeHarnessMain({...f.options,authorize:async p=>!p.endsWith('/.git')});expect(result.state).toBe('not-observed');
});
it('refuses Git configuration indirection before Git reads it',async()=>{
 const f=await fixture();await fs.appendFile(path.join(f.root,'.git','config'),'\n[include]\npath = /unapproved/config\n');
 expect((await observeHarnessMain(f.options)).state).toBe('not-observed');
});
it('does not fetch or guess another branch when main is unavailable',async()=>{
 const f=await fixture();f.git('branch','-D','main');expect((await observeHarnessMain(f.options)).state).toBe('not-observed');
});
