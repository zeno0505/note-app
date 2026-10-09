import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,rm,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectInstallation,readInstallation,verificationProfile,allowInstallation,validBuildNumber,canonicalTargetVerified} from '../../src/main/install-identity';
const roots:string[]=[];
const metadata={sourceSha:'a'.repeat(40),installation:{role:'user',buildNumber:'2'}};
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(ancestry:string[]=[]){const root=await realpath(await mkdtemp(path.join(tmpdir(),'note-app-install-')));roots.push(root);const home=path.join(root,...ancestry,'home'),bundle=path.join(home,'Applications','note-app.app'),appRoot=path.join(bundle,'Contents/Resources/app');await mkdir(appRoot,{recursive:true});await writeFile(path.join(appRoot,'package.json'),JSON.stringify(metadata));return {root,home,bundle,appRoot};}
describe('package installation boundary',()=>{
  it('accepts the canonical user package but rejects a copied or symlinked bundle',async()=>{
    const f=await fixture();expect(readInstallation(true,'darwin',f.appRoot,f.home).role).toBe('user');
    const copy=path.join(f.root,'copied.app');await mkdir(path.join(copy,'Contents/Resources/app'),{recursive:true});await writeFile(path.join(copy,'Contents/Resources/app/package.json'),JSON.stringify(metadata));
    expect(readInstallation(true,'darwin',path.join(copy,'Contents/Resources/app'),f.home).role).toBe('blocked');
    await rm(f.bundle,{recursive:true});await symlink(copy,f.bundle);expect(readInstallation(true,'darwin',f.appRoot,f.home).role).toBe('blocked');
  });
  it('fails closed for missing role/build/source metadata and rejects invalid Mac build numbers',()=>{
    for(const value of [null,{}, {...metadata,installation:{}},{...metadata,sourceSha:'unknown'},{...metadata,installation:{role:'other',buildNumber:'2'}},{...metadata,installation:{role:'user',buildNumber:'02'}}])expect(inspectInstallation(value,'/home/Applications/note-app.app','/home').role).toBe('blocked');
    for(const value of ['0','02','2.1','10000','2\n',2,null])expect(validBuildNumber(value)).toBe(false);
    expect(validBuildNumber('2')).toBe(true);expect(validBuildNumber('9999')).toBe(true);
  });
  it.each([
    {name:'ordinary temporary parent',ancestry:[]},
    {name:'source updater temporary parent',ancestry:['Library','Application Support','note-app-updater','tmp']},
    {name:'note-app named ancestor',ancestry:['Library','Application Support','note-app']},
  ])('keeps verification storage separate and refuses a symlink to an existing profile ($name)',async({ancestry})=>{
    const f=await fixture(ancestry);const identity=inspectInstallation({...metadata,installation:{role:'verification',buildNumber:'2'}},f.bundle,f.home);
    // Check the actual bundle-sibling boundary, not unrelated ancestor names in TMPDIR.
    expect(identity.role).toBe('verification');const profile=verificationProfile(identity);expect(profile).toBe(path.join(path.dirname(f.bundle),'.note-app-verification','2-'+metadata.sourceSha));
    const base=path.dirname(profile);await rm(base,{recursive:true});const sensitive=path.join(f.root,'existing-profile');await mkdir(sensitive);await writeFile(path.join(sensitive,'sentinel'),'preserve');await symlink(sensitive,base);
    expect(()=>verificationProfile(identity)).toThrow('Unsafe verification profile');expect(await readdir(sensitive)).toEqual(['sentinel']);
  });
  it('rejects stale or verification canonical targets before offering to open them',async()=>{
    const f=await fixture();const identity=inspectInstallation(metadata,path.join(f.root,'wrong.app'),f.home);
    for(const installation of [{role:'user',buildNumber:'1'},{role:'verification',buildNumber:'2'}]){await writeFile(path.join(f.appRoot,'package.json'),JSON.stringify({...metadata,installation}));expect(await canonicalTargetVerified(identity)).toBe(false);}
  });
  it('stops startup for wrong paths and only opens the verified exact target after explicit choice',async()=>{
    const identity=inspectInstallation(metadata,'/wrong/note-app.app','/home'),open=vi.fn(),warn=vi.fn(async()=>1),verify=vi.fn(async()=>false);
    expect(await allowInstallation(identity,{targetVerified:verify,warn,openCanonical:open})).toBe(false);expect(warn).toHaveBeenCalledWith(false);expect(open).not.toHaveBeenCalled();
    verify.mockResolvedValue(true);expect(await allowInstallation(identity,{targetVerified:verify,warn,openCanonical:open})).toBe(false);expect(open).toHaveBeenCalledTimes(1);
    warn.mockResolvedValue(0);await allowInstallation(identity,{targetVerified:verify,warn,openCanonical:open});expect(open).toHaveBeenCalledTimes(1);
  });
  it('does not invoke guard side effects for canonical, verification or ordinary development starts',async()=>{
    const actions={targetVerified:vi.fn(),warn:vi.fn(),openCanonical:vi.fn()};
    for(const identity of [inspectInstallation(metadata,'/home/Applications/note-app.app','/home'),inspectInstallation({...metadata,installation:{role:'verification',buildNumber:'2'}},'/test/app.app','/home'),readInstallation(false,'darwin','/source','/home')])expect(await allowInstallation(identity,actions)).toBe(true);
    expect(actions.targetVerified).not.toHaveBeenCalled();expect(actions.warn).not.toHaveBeenCalled();expect(actions.openCanonical).not.toHaveBeenCalled();
  });
});
