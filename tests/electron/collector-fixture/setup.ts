import {mkdtemp,mkdir,writeFile,readFile,chmod,symlink,rm,lstat} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
export const roots=new Set<string>();
export const scenarios=['normal','missing','denied','slow'] as const;
export type Scenario=typeof scenarios[number];
export async function fixture(scenario:Scenario){
  const root=await mkdtemp(join(tmpdir(),'note-app-collector-'));roots.add(root);
  const executableDirectory=join(root,'cli');await mkdir(executableDirectory);
  for(const name of ['status','projects','worktrees','processes']){
    const source=JSON.parse(await readFile(resolve(`fixtures/orca/${name}.json`),'utf8'));
    source.preview='SYNTHETIC_PRIVATE_BODY';source.prompt='SYNTHETIC_PRIVATE_BODY';
    if(Array.isArray(source.result?.worktrees)) for(const row of source.result.worktrees){row.preview='SYNTHETIC_PRIVATE_BODY';row.prompt='SYNTHETIC_PRIVATE_BODY';if(row.agents)for(const agent of row.agents){agent.lastAssistantMessage='SYNTHETIC_PRIVATE_BODY';agent.toolInput='SYNTHETIC_PRIVATE_BODY';}}
    await writeFile(join(executableDirectory,`${name}.json`),JSON.stringify(source));
  }
  const node=process.env.NOTE_APP_TEST_NODE;
  if(!node||!isAbsolute(node)||/\s/.test(node))throw new Error('A trusted Node executable is required for this test fixture');
  const mock=await readFile(resolve('fixtures/orca/mock-orca.cjs'),'utf8');
  const executable=join(executableDirectory,'orca-test');
  await writeFile(executable,`#!${node}\nprocess.env.NOTE_APP_ORCA_FIXTURE_ROOT=${JSON.stringify(root)};\n${mock}`);await chmod(executable,0o700);
  if(scenario==='denied')await writeFile(join(executableDirectory,'mode.json'),JSON.stringify({kind:'denied',query:'worktrees'}));
  if(scenario==='slow')await writeFile(join(executableDirectory,'mode.json'),JSON.stringify({kind:'hang',query:'projects'}));
  const vault=join(root,'vault'),scope=join(vault,'project');await mkdir(scope,{recursive:true});await writeFile(join(scope,'dag.yaml'),'schema: 2\ntasks: []\n');
  const first=join(root,'demo'),second=join(root,'second');await mkdir(join(first,'docs'),{recursive:true});await mkdir(join(second,'docs'),{recursive:true});await symlink(scope,join(first,'docs/note'));
  if(scenario!=='missing')await symlink(scope,join(second,'docs/note'));
  const initialLink=await lstat(join(first,'docs/note'));
  return {root,executable,vault,scope,first,second,initialLink:{ino:initialLink.ino,mtimeMs:initialLink.mtimeMs,mode:initialLink.mode}};
}
export async function cleanup(){await Promise.all([...roots].map(root=>rm(root,{recursive:true,force:true})));roots.clear();}
