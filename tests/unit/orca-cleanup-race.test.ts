import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { finalizeQueryGroup } from '../../src/collector/orca/process-group';
import { waitForReadyPid } from './helpers/process-startup';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,readdir:vi.fn(actual.readdir)};
});

async function executing(pid: number): Promise<boolean> {
  try {const stat=await readFile(`/proc/${pid}/stat`,'utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error;}
}

it.skipIf(process.platform!=='linux')('does not mistake a fork-after-enumeration procfs snapshot for group exit',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'note-app-orca-race-'));
  const ready=join(directory,'ready');const successorFile=join(directory,'successor');
  const code=`
    const fs=require('node:fs');const {spawn}=require('node:child_process');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
    process.on('SIGTERM',()=>{});
    process.on('SIGUSR1',()=>{
      const successor=spawn(process.execPath,['-e',
        'const fs=require("node:fs");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2300);process.on("SIGTERM",()=>{});setInterval(()=>{},1000);fs.writeFileSync(process.argv[1],String(process.pid));process.send("ready");process.disconnect();',
        process.argv[2]],{stdio:['ignore','ignore','ignore','ipc']});
      successor.once('error',error=>{throw error;});
      successor.once('message',message=>{if(message!=="ready")throw new Error("Unexpected successor handshake");process.exit(0);});
      successor.unref();
    });
    fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);
  `;
  const root=spawn(process.execPath,['-e',code,ready,successorFile],{stdio:'ignore',detached:true});
  const closed=new Promise<void>(resolve=>root.once('close',()=>resolve()));
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const originalKill=process.kill.bind(process);
  try {
    await waitForReadyPid(directory);
    const originalEntries=await actual.readdir('/proc');
    root.kill('SIGUSR1');
    const successor=await waitForReadyPid(directory,'successor');await closed;
    expect(await executing(successor)).toBe(true);
    // Return an actual snapshot taken before this same-group successor existed.
    // Readiness happens outside the production 100 ms procfs-observation bound,
    // so slow Node startup cannot change which cleanup race this test exercises.
    vi.mocked(readdir).mockResolvedValueOnce(originalEntries as never);
    const killSpy=vi.spyOn(process,'kill');
    expect(await finalizeQueryGroup(root)).toBe(true);
    expect(killSpy.mock.calls.some(([pid,signal])=>pid===-root.pid!&&signal==='SIGKILL')).toBe(true);
    expect(await executing(successor)).toBe(false);
    const hardKillIndex=killSpy.mock.calls.findIndex(([pid,signal])=>pid===-root.pid!&&signal==='SIGKILL');
    expect(killSpy.mock.calls.slice(hardKillIndex+1).some(([pid,signal])=>pid===-root.pid!&&signal===0)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    try {if(root.pid) originalKill(-root.pid,'SIGKILL');} catch {}
    await closed;await rm(directory,{recursive:true,force:true});
  }
},10_000);
