// Run from a graphical desktop with `node tests/electron/bundle-integrity-smoke.mjs`.
// This checks physical bundle hashing in normal Electron, not macOS signing/install.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const evidence=path.resolve(process.env.NOTE_APP_BUNDLE_INTEGRITY_EVIDENCE??'test-results/bundle-integrity');
await mkdir(evidence,{recursive:true,mode:0o700});
const root=await realpath(await mkdtemp(path.join(evidence,'run-')));
const electron=createRequire(import.meta.url)('electron');
const resources=process.platform==='darwin'?path.resolve(path.dirname(electron),'../Resources'):path.join(path.dirname(electron),'resources');
const archive=path.join(resources,'default_app.asar'),bytes=await readFile(archive);
assert(bytes.length>0,'Installed Electron must provide a real default_app.asar');
const compiled=path.join(root,'bundle-integrity.cjs');
await build({entryPoints:[path.join(repo,'scripts/updater/bundle-integrity.mjs')],outfile:compiled,bundle:true,platform:'node',format:'cjs',target:'node24'});
const cases=[];
for(const kind of ['original','archive-byte','unpacked-tree','asar-named-directory']) {
  const bundle=path.join(root,kind,'fixture.app'),content=path.join(bundle,'Contents/Resources');
  await mkdir(path.join(content,'default_app.asar.unpacked'),{recursive:true,mode:0o755});
  await mkdir(path.join(content,'plain.asar'),{mode:0o755});
  await cp(archive,path.join(content,'default_app.asar'));
  await writeFile(path.join(content,'default_app.asar.unpacked/extra.txt'),'unpacked original\n');
  await writeFile(path.join(content,'plain.asar/entry.txt'),'directory original\n');
  if(kind==='archive-byte'){const changed=Buffer.from(bytes);changed[changed.length-1]^=1;await writeFile(path.join(content,'default_app.asar'),changed);}
  if(kind==='unpacked-tree')await writeFile(path.join(content,'default_app.asar.unpacked/extra.txt'),'unpacked modified\n');
  if(kind==='asar-named-directory')await writeFile(path.join(content,'plain.asar/entry.txt'),'directory modified\n');
  cases.push({kind,bundle,nodeDigest:await hashAppBundle(bundle)});
}
assert.equal(new Set(cases.map(item=>item.nodeDigest)).size,cases.length,'Every physical mutation must change the digest');
const config={root,compiled,cases,moduleUrl:pathToFileURL(path.join(repo,'scripts/updater/bundle-integrity.mjs')).href,archiveSha256:createHash('sha256').update(bytes).digest('hex')};
await writeFile(path.join(root,'config.json'),JSON.stringify(config,null,2)+'\n');
const entry=path.join(root,'main.cjs');
await writeFile(entry,`'use strict';
const {app}=require('electron'),fs=require('node:fs/promises'),physical=require('original-fs').promises,assert=require('node:assert/strict'),path=require('node:path');
const config=require('./config.json'),resultFile=path.join(config.root,'electron-result.json');
app.setPath('userData',path.join(config.root,'profile'));app.setPath('logs',path.join(config.root,'logs'));
(async()=>{
 await app.whenReady();
 assert.equal(process.type,'browser');assert(process.versions.electron);assert(!process.env.ELECTRON_RUN_AS_NODE);assert(!app.commandLine.hasSwitch('no-sandbox'));assert(!app.commandLine.hasSwitch('disable-setuid-sandbox'));
 const noAsarBefore=process.noAsar,esm=await import(config.moduleUrl),cjs=require(config.compiled),results=[];
 for(const item of config.cases){
  const [esmDigest,cjsDigest]=await Promise.all([esm.hashAppBundle(item.bundle),cjs.hashAppBundle(item.bundle)]);
  assert.equal(esmDigest,item.nodeDigest);assert.equal(cjsDigest,item.nodeDigest);assert.equal(process.noAsar,noAsarBefore);
  results.push({...item,esmDigest,cjsDigest});
 }
 const member=path.join(config.cases[0].bundle,'Contents/Resources/default_app.asar/default_app.js');
 const virtualBytes=await fs.readFile(member);assert(virtualBytes.length>0);
 await assert.rejects(physical.lstat(member),{code:'ENOTDIR'});
 const result={passed:true,platform:process.platform,electron:process.versions.electron,node:process.versions.node,processType:process.type,argv:process.argv,electronRunAsNode:process.env.ELECTRON_RUN_AS_NODE||null,noSandbox:false,disableSetuidSandbox:false,processNoAsarBefore:noAsarBefore??null,processNoAsarAfter:process.noAsar??null,archiveSha256:config.archiveSha256,virtualMemberBytes:virtualBytes.length,cases:results,scope:'Real installed Electron ASAR bytes in synthetic .app-shaped fixtures. Native signing, packaging, installation and source preparation are not performed.'};
 await fs.writeFile(resultFile,JSON.stringify(result,null,2)+'\\n');app.quit();
})().catch(async error=>{await fs.writeFile(resultFile,JSON.stringify({passed:false,message:error.message,stack:error.stack},null,2)+'\\n');app.exit(1);});
`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let stdout='',stderr='';
const child=spawn(electron,[entry],{cwd:repo,env,shell:false,stdio:['ignore','pipe','pipe']});
const timer=setTimeout(()=>child.kill('SIGTERM'),60000);timer.unref();
try {
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  await writeFile(path.join(root,'electron.stdout.log'),stdout);await writeFile(path.join(root,'electron.stderr.log'),stderr);
  await writeFile(path.join(root,'exit.json'),JSON.stringify(exit)+'\n');
  assert.equal(exit.code,0,stderr);assert.equal(exit.signal,null);
  const result=JSON.parse(await readFile(path.join(root,'electron-result.json'),'utf8'));assert.equal(result.passed,true);
  console.log(JSON.stringify({passed:true,evidence:root,cases:result.cases.map(({kind,nodeDigest})=>({kind,nodeDigest})),scope:result.scope},null,2));
}finally{clearTimeout(timer);}
