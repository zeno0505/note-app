import {lstatSync,readFileSync,realpathSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

export interface InstallationIdentity {
  role:'development'|'user'|'verification'|'blocked';
  currentPath:string;canonicalPath:string;buildSha:string|null;buildNumber:string|null;
}
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
export const validBuildNumber=(x:unknown):x is string=>typeof x==='string'&&/^[1-9]\d{0,3}$/.test(x)&&String(Number(x))===x;
/** Package metadata is main-owned. No argv, environment, renderer or live-config override. */
export function inspectInstallation(metadata:unknown,currentPath:string,home:string):InstallationIdentity {
  const canonicalPath=path.join(home,'Applications','note-app.app');
  const base:InstallationIdentity={role:'blocked',currentPath,canonicalPath,buildSha:null,buildNumber:null};
  if(!record(metadata)||typeof metadata.sourceSha!=='string'||metadata.sourceSha.length!==40||!/^[a-f0-9]{40}$/.test(metadata.sourceSha)
    ||!record(metadata.installation)||!validBuildNumber(metadata.installation.buildNumber)
    ||!['user','verification'].includes(String(metadata.installation.role)))return base;
  return {...base,role:metadata.installation.role==='verification'?'verification':currentPath===canonicalPath?'user':'blocked',
    buildSha:metadata.sourceSha,buildNumber:metadata.installation.buildNumber};
}
function metadataAt(bundle:string):unknown {
  const file=path.join(bundle,'Contents','Resources','app','package.json'),s=lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.size>16384)throw Error('Invalid package metadata');
  return JSON.parse(readFileSync(file,'utf8'));
}
export function readInstallation(packaged:boolean,platform:string,appRoot:string,home:string):InstallationIdentity {
  if(!packaged||platform!=='darwin')return {role:'development',currentPath:appRoot,canonicalPath:path.join(home,'Applications','note-app.app'),buildSha:null,buildNumber:null};
  const bundle=path.resolve(appRoot,'../../..');
  try{return inspectInstallation(metadataAt(bundle),realpathSync(bundle),home);}
  catch{return inspectInstallation(null,bundle,home);}
}
export function verificationProfile(identity:InstallationIdentity):string {
  if(identity.role!=='verification'||!identity.buildSha||!identity.buildNumber)throw Error('Not a verification package');
  const base=path.join(path.dirname(identity.currentPath),'.note-app-verification');
  const check=(dir:string)=>{const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(dir)!==dir||s.uid!==process.geteuid?.()||(s.mode&0o077)!==0)throw Error('Unsafe verification profile');};
  for(const dir of [base,path.join(base,identity.buildNumber+'-'+identity.buildSha)]){
    try{mkdirSync(dir,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}check(dir);
  }
  return path.join(base,identity.buildNumber+'-'+identity.buildSha);
}
export async function canonicalTargetVerified(identity:InstallationIdentity):Promise<boolean> {
  try{
    if(realpathSync(identity.canonicalPath)!==identity.canonicalPath)return false;
    const target=inspectInstallation(metadataAt(identity.canonicalPath),identity.canonicalPath,path.dirname(path.dirname(identity.canonicalPath)));
    if(target.role!=='user'||!target.buildNumber||!identity.buildNumber||Number(target.buildNumber)<Number(identity.buildNumber))return false;
    return await new Promise(resolve=>execFile('/usr/bin/codesign',['--verify','--deep','--strict',identity.canonicalPath],
      {timeout:5000,maxBuffer:4096},error=>resolve(!error)));
  }catch{return false;}
}
/** A rejected path never starts collection, IPC or AI. Only a verified exact target can open. */
export async function allowInstallation(identity:InstallationIdentity,actions:{
  targetVerified:()=>Promise<boolean>;warn:(canOpen:boolean)=>Promise<number>;openCanonical:()=>Promise<unknown>;
}):Promise<boolean> {
  if(identity.role!=='blocked')return true;
  const canOpen=await actions.targetVerified();
  const choice=await actions.warn(canOpen);
  if(canOpen&&choice===1)await actions.openCanonical();
  return false;
}
