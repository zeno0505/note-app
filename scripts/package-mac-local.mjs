import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,readFile,writeFile,lstat,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hashAppBundle} from './updater/bundle-integrity.mjs';
const {values}=parseArgs({options:{output:{type:'string'},config:{type:'string'},verification:{type:'boolean',default:false},'build-number':{type:'string'}}});
if(process.platform!=='darwin'||!values.output||!path.isAbsolute(values.output)||!values.output.endsWith('.app'))throw new Error('Use macOS and --output with a new absolute .app path');
const buildNumber=values['build-number'];
if(!buildNumber||!/^[1-9]\d{0,3}$/.test(buildNumber)||String(Number(buildNumber))!==buildNumber)throw new Error('Use an explicit increasing --build-number (1..9999)');
if(values.verification&&values.config)throw new Error('Verification packages cannot carry a live configuration');
const role=values.verification?'verification':'user',displayName=values.verification?'note-app Verification':'note-app',bundleId=values.verification?'dev.noteapp.verification':'dev.noteapp.local';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw new Error('Commit and verify the exact source before packaging');
const sha=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
const source=path.resolve('node_modules/electron/dist/Electron.app'),target=values.output;
try{await lstat(target);throw new Error('Output already exists; choose a new path');}catch(error){if(error.code!=='ENOENT')throw error;}
if(values.config)throw new Error('Personal configuration must remain outside the app bundle. Use the private note-app userData/live-config.json or NOTE_APP_CONFIG; legacy bundles migrate on startup.');
const packageVersion=JSON.parse(await readFile('package.json','utf8')).version;
if(typeof packageVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(packageVersion))throw new Error('Invalid package version');
// A fresh build ties the application bytes to the checked clean source.
execFileSync('npm',['run','build'],{stdio:'inherit'});
await mkdir(path.dirname(target),{recursive:true,mode:0o700});
await cp(source,target,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
const resources=path.join(target,'Contents','Resources'),appRoot=path.join(resources,'app');await mkdir(appRoot,{mode:0o755});await cp('dist',path.join(appRoot,'dist'),{recursive:true});
await writeFile(path.join(appRoot,'package.json'),JSON.stringify({name:values.verification?'note-app-verification':'note-app',version:packageVersion,sourceSha:sha,updaterProtocolVersion:1,installation:{role,buildNumber},private:true,main:'dist/main/index.cjs'},null,2)+'\n');
const plist=path.join(target,'Contents','Info.plist');
// Electron's macOS isPackaged checks the executable basename. Keeping Electron
// would disable bundled startup configuration even after a Finder launch.
await rename(path.join(target,'Contents','MacOS','Electron'),path.join(target,'Contents','MacOS','note-app'));
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleExecutable note-app',plist]);
for(const [key,value] of [['CFBundleDisplayName',displayName],['CFBundleName',displayName],['CFBundleIdentifier',bundleId],['CFBundleShortVersionString',packageVersion],['CFBundleVersion',buildNumber]])execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
execFileSync('/usr/bin/plutil',['-lint',plist],{stdio:'inherit'});
// Ad hoc signing of this owned copy only. No account, certificate or OS setting changes.
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements',target],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',target],{stdio:'inherit'});
if(git('rev-parse','HEAD')!==sha||git('status','--porcelain'))throw new Error('Source changed during packaging; do not validate this artifact');
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const manifest={kind:'local-mac-app',version:packageVersion,lockfileSha256:await hash('package-lock.json'),appSha256:await hashAppBundle(target),sourceSha:sha,sourceTree:tree,role,bundleId,buildNumber,createdAt:new Date().toISOString(),electronVersion:JSON.parse(await readFile('node_modules/electron/package.json','utf8')).version,architecture:process.arch,adHocSignatureVerified:true,configuration:'external-private-config',entrySha256:await hash(path.join(appRoot,'dist/main/index.cjs')),preloadSha256:await hash(path.join(appRoot,'dist/preload/index.cjs')),nativeAcceptance:'pending',modelCalls:0};
await writeFile(target+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({app:target,manifest:target+'.manifest.json',...manifest}));
