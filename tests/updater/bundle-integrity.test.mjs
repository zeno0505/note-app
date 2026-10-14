import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';

const {mkdtemp,realpath,mkdir,writeFile,readFile,rm,chmod,symlink,link,rename,appendFile}=fs.promises;
let moduleNumber=0;
async function fixture(t) {
  const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'note-bundle-integrity-')));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const bundle=path.join(home,'fixture.app');await mkdir(bundle,{mode:0o700});
  const archive=path.join(bundle,'default_app.asar');
  // Even malformed archives are opaque physical bytes for bundle integrity.
  const bytes=Buffer.from('opaque archive bytes\0with content');await writeFile(archive,bytes,{mode:0o644});
  // The digest oracle fixes this mode; a caller's restrictive umask must not
  // silently change the fixture while leaving the expected record unchanged.
  await chmod(archive,0o644);
  return {home,bundle,archive,bytes};
}
async function isolatedHasher(){return (await import(`../../scripts/updater/bundle-integrity.mjs?test=${++moduleNumber}`)).hashAppBundle;}

test('hashes archive bytes using the unchanged physical record format',async t=>{
  const f=await fixture(t);const expected=createHash('sha256');
  expected.update(JSON.stringify(['directory','',0o700])+'\n');
  expected.update(JSON.stringify(['file','default_app.asar',0o644,f.bytes.length])+'\n');
  expected.update(f.bytes);expected.update('\n');
  assert.equal(await hashAppBundle(f.bundle),expected.digest('hex'));
});
test('archive bytes, executable bits, names and unpacked payloads remain bound',async t=>{
  const f=await fixture(t);let previous=await hashAppBundle(f.bundle);
  const changed=async()=>{const next=await hashAppBundle(f.bundle);assert.notEqual(next,previous);previous=next;};
  await writeFile(f.archive,Buffer.alloc(f.bytes.length,42));await changed();
  await chmod(f.archive,0o755);await changed();
  await rename(f.archive,f.archive+'.renamed');await changed();
  const unpacked=path.join(f.bundle,'default_app.asar.unpacked');await mkdir(unpacked,{mode:0o755});
  const payload=path.join(unpacked,'native.node');await writeFile(payload,'payload');await changed();
  await writeFile(payload,'changed');await changed();
});
test('a physical directory ending in .asar is walked normally',async t=>{
  const f=await fixture(t);const directory=path.join(f.bundle,'directory.asar');await mkdir(directory);
  await writeFile(path.join(directory,'entry'),'before');const before=await hashAppBundle(f.bundle);
  await writeFile(path.join(directory,'entry'),'after');assert.notEqual(await hashAppBundle(f.bundle),before);
});
test('safe framework links are bound while escaping and absolute links are refused',async t=>{
  const f=await fixture(t);await symlink('default_app.asar',path.join(f.bundle,'current'));
  const linked=await hashAppBundle(f.bundle);await rm(path.join(f.bundle,'current'));
  assert.notEqual(await hashAppBundle(f.bundle),linked);
  await writeFile(path.join(f.home,'outside'),'private');await symlink('../outside',path.join(f.bundle,'escape'));
  await assert.rejects(hashAppBundle(f.bundle),/Bundle link escapes root/);
  await rm(path.join(f.bundle,'escape'));await symlink(f.archive,path.join(f.bundle,'absolute'));
  await assert.rejects(hashAppBundle(f.bundle),/Unsafe bundle link/);
});
test('canonical root, symlink root, hard links and writable entries remain rejected',async t=>{
  const f=await fixture(t);await assert.rejects(hashAppBundle(f.bundle+'/../fixture.app'),/Noncanonical/);
  const alias=path.join(f.home,'alias');await symlink('fixture.app',alias);await assert.rejects(hashAppBundle(alias),/Unsafe bundle root/);
  const outside=path.join(f.home,'hardlink');await link(f.archive,outside);await assert.rejects(hashAppBundle(f.bundle),/Unsupported bundle entry/);
  await rm(outside);await chmod(f.archive,0o666);await assert.rejects(hashAppBundle(f.bundle),/Unsafe bundle entry/);
});
test('replacement between physical lstat and open still rejects identity mismatch',async t=>{
  const f=await fixture(t);const original=fs.promises.open;
  t.mock.method(fs.promises,'open',async(file,...args)=>{
    if(file===f.archive){await rename(file,file+'.old');await writeFile(file,f.bytes,{mode:0o644});}
    return original(file,...args);
  });
  const hash=await isolatedHasher();await assert.rejects(hash(f.bundle),/Bundle changed during verification/);
});
test('a symlink substituted before open cannot be followed',async t=>{
  const f=await fixture(t);const original=fs.promises.open;
  t.mock.method(fs.promises,'open',async(file,...args)=>{
    if(file===f.archive){await rename(file,file+'.old');await symlink('default_app.asar.old',file);}
    return original(file,...args);
  });
  const hash=await isolatedHasher();await assert.rejects(hash(f.bundle),error=>error.code==='ELOOP');
});
test('content changed after the read still fails the post-read snapshot check',async t=>{
  const f=await fixture(t);const original=fs.promises.open;
  t.mock.method(fs.promises,'open',async(file,...args)=>{
    const handle=await original(file,...args);if(file!==f.archive)return handle;
    const stat=handle.stat.bind(handle);let calls=0;
    handle.stat=async(...options)=>{if(++calls===2)await appendFile(file,'changed');return stat(...options);};
    return handle;
  });
  const hash=await isolatedHasher();await assert.rejects(hash(f.bundle),/Bundle changed during verification/);
  assert.equal((await readFile(f.archive)).length,f.bytes.length+7);
});
test('an Electron runtime without original-fs fails closed instead of using virtual fs',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(process.versions,'electron');
  // Ordinary Node cannot resolve Electron's built-in; simulate only its runtime
  // marker to prove the selector does not catch that failure and fall back.
  assert.equal(descriptor,undefined);
  Object.defineProperty(process.versions,'electron',{value:'test-runtime',configurable:true});
  try {await assert.rejects(isolatedHasher(),error=>error.code==='MODULE_NOT_FOUND'&&error.message.includes('original-fs'));}
  finally {delete process.versions.electron;}
});
