import {writeFile,readFile,rename,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createSummaryReviewFixture} from '../summary-review-fixture/setup.mjs';
export async function createGitMetadataFixture(){
 const base=await createSummaryReviewFixture(),repository=path.join(base.root,'synthetic Git origin'),worktree=path.join(base.root,'handoff checkout');
 const git=(args,input)=>execFileSync('git',args,{cwd:repository,input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 execFileSync('git',['init','-b','synthetic',repository],{stdio:'ignore'});const tree=git(['mktree'],''),commits=[];
 for(let i=0;i<429;i++){const at=Math.floor(Date.parse('2026-10-09T14:00:00Z')/1000)+i*60;commits.push(git(['hash-object','-t','commit','-w','--stdin'],`tree ${tree}\nauthor Synthetic <synthetic@example.invalid> ${at} +0000\ncommitter Synthetic <synthetic@example.invalid> ${at} +0000\n\nSynthetic task activity ${i}\n`));}
 git(['update-ref','refs/heads/synthetic',commits[0]]);for(const name of ['atlas checkout','handoff checkout']){const target=path.join(base.root,name),backup=path.join(base.root,name+' original');await rename(target,backup);git(['worktree','add','--detach',target,commits[0]]);await rename(path.join(backup,'docs'),path.join(target,'docs'));await rm(backup,{recursive:true,force:true});}
 const dag=JSON.parse(await readFile(base.dagPath,'utf8'));for(const task of dag.phases[0].tasks)task.commits=[];commits.forEach((sha,i)=>dag.phases[0].tasks[i%6].commits.push(i%2?sha.slice(0,8):sha));await writeFile(base.dagPath,JSON.stringify(dag));
 return {...base,repository,worktree,commonDirectory:path.join(repository,'.git'),commits,expectedRecent:['R-3','T-2','T-1'],declaredCount:429};
}
