import {describe,expect,it,vi} from 'vitest';
import type {NoteAppBridge} from '../../src/shared/bridge';
import {createEmptyProjectDraftInput} from '../../src/shared/project-draft';
const electron=vi.hoisted(()=>({exposeInMainWorld:vi.fn(),invoke:vi.fn(async()=>[]),on:vi.fn(),removeListener:vi.fn()}));
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:electron.exposeInMainWorld},ipcRenderer:electron}));
import '../../src/preload/index';
describe('Phase3 narrow project draft preload surface',()=>{
  it('exposes only fixed list/save channels through the frozen application bridge',async()=>{
    const [name,bridge]=electron.exposeInMainWorld.mock.calls[0] as [string,NoteAppBridge];
    expect(name).toBe('noteApp');expect(Object.isFrozen(bridge)).toBe(true);
    await bridge.listProjectDrafts();expect(electron.invoke).toHaveBeenLastCalledWith('note-app:project-drafts-list');
    const request={id:null,expectedRevision:null,input:createEmptyProjectDraftInput()};
    await bridge.saveProjectDraft(request);expect(electron.invoke).toHaveBeenLastCalledWith('note-app:project-draft-save',request);
    for(const forbidden of ['invoke','readFile','writeFile','execute','fetch','openWorkspace'])expect(bridge).not.toHaveProperty(forbidden);
  });
});
