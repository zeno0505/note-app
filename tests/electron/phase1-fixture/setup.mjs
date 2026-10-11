import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,rm,realpath,lstat,readlink,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createLiveFixture} from '../live-fixture/setup.mjs';

/** Only temporary fictional sources and real local Git metadata are writable. */
export async function createPhase1Fixture(){
  const base=await createLiveFixture();
  const worktrees=[path.join(base.root,'atlas checkout'),path.join(base.root,'handoff checkout')];
  const scope=base.config.noteScopes[0].scopePath;
  const git=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  assert(path.isAbsolute(git));
  const runGit=(args,cwd=worktrees[0])=>execFileSync(git,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  runGit(['init','-b','fictional-main']);
  runGit(['-c','user.name=Fictional Test','-c','user.email=fictional@example.invalid','commit','--allow-empty','-m','Fictional temporary fixture']);
  await rm(worktrees[1],{recursive:true});
  runGit(['worktree','add','-b','fictional-handoff',worktrees[1],'HEAD']);
  const commonGitDirectory=await realpath(path.join(worktrees[0],'.git'));
  const exclude=path.join(commonGitDirectory,'info','exclude');
  base.config.noteLink={gitExecutablePath:git,allowedCommonGitDirs:[commonGitDirectory]};
  await writeFile(base.configPath,JSON.stringify(base.config),{mode:0o600});
  // Deliberately absent goal: the product must state the gap, not manufacture one.
  await rm(path.join(scope,'goal.md'));
  const controlPath=path.join(base.root,'phase1-test-control.json');
  const transportLog=path.join(base.root,'phase1-test-transport.jsonl');
  let control={mode:'complete',submittedDelayMs:350,waitingDelayMs:500,responseDelayMs:650};
  async function setTransport(change){control={...control,...change};await writeFile(controlPath,JSON.stringify(control));}
  await setTransport({});
  async function transportCalls(){try{return (await readFile(transportLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
  async function metadata(filename){
    try{const stat=await lstat(filename);return {exists:true,kind:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':'file',ino:stat.ino,mode:stat.mode,mtimeMs:stat.mtimeMs,...(stat.isSymbolicLink()?{target:await readlink(filename)}:stat.isFile()?{hash:createHash('sha256').update(await readFile(filename)).digest('hex')}: {})};}
    catch(error){if(error.code==='ENOENT')return {exists:false};throw error;}
  }
  const noteSnapshot=async()=>Object.fromEntries(await Promise.all(['dag.yaml','goal.md'].map(async name=>[name,await metadata(path.join(scope,name))])));
  const linkSnapshot=async()=>({docs:await metadata(path.join(worktrees[1],'docs')),note:await metadata(path.join(worktrees[1],'docs','note')),exclude:await metadata(exclude)});
  async function cacheFiles(userData){
    const result=[];
    async function walk(dir){let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      for(const entry of entries){const filename=path.join(dir,entry.name);if(entry.isDirectory())await walk(filename);else {assert(entry.isFile(),'Cache contains an unexpected symlink');result.push({path:filename,relative:path.relative(userData,filename),hash:createHash('sha256').update(await readFile(filename)).digest('hex')});}}
    }
    await walk(path.join(userData,'summary-cache'));return result.sort((a,b)=>a.relative.localeCompare(b.relative));
  }
  return {...base,worktrees,scope,git,runGit,commonGitDirectory,exclude,controlPath,transportLog,setTransport,transportCalls,noteSnapshot,linkSnapshot,metadata,cacheFiles};
}
