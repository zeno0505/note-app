import { contextBridge, ipcRenderer } from 'electron';
import type { NoteAppBridge } from '../shared/bridge';
const bridge: NoteAppBridge = Object.freeze({
  getEnvironment: () => ipcRenderer.invoke('note-app:environment'),
  getReadRoots:()=>ipcRenderer.invoke('note-app:read-roots'),
  selectReadRoot:()=>ipcRenderer.invoke('note-app:read-root-select'),
  confirmReadRoot:(request:Parameters<NoteAppBridge['confirmReadRoot']>[0])=>ipcRenderer.invoke('note-app:read-root-confirm',request),
  cancelReadRoot:(request:Parameters<NoteAppBridge['cancelReadRoot']>[0])=>ipcRenderer.invoke('note-app:read-root-cancel',request),
  revokeReadRoot:(request:Parameters<NoteAppBridge['revokeReadRoot']>[0])=>ipcRenderer.invoke('note-app:read-root-revoke',request),
  loadDemo: (request: Parameters<NoteAppBridge['loadDemo']>[0]) => ipcRenderer.invoke('note-app:demo', request),
  getLiveState: () => ipcRenderer.invoke('note-app:live-state'),
  connectLive: () => ipcRenderer.invoke('note-app:live-connect'),
  refreshLive: () => ipcRenderer.invoke('note-app:live-refresh'),
  summarizeNow: () => ipcRenderer.invoke('note-app:reading-summary-now'),
  disconnectLive: () => ipcRenderer.invoke('note-app:live-disconnect'),
  openProjectDocument:(request:Parameters<NoteAppBridge['openProjectDocument']>[0])=>ipcRenderer.invoke('note-app:project-document-open',request),
  confirmProjectConnection:(request:Parameters<NoteAppBridge['confirmProjectConnection']>[0])=>ipcRenderer.invoke('note-app:project-connection-confirm',request),
  setProjectStatus:(request:Parameters<NoteAppBridge['setProjectStatus']>[0])=>ipcRenderer.invoke('note-app:project-status',request),
  prepareSummary: (request:Parameters<NoteAppBridge['prepareSummary']>[0])=>ipcRenderer.invoke('note-app:summary-prepare',request),
  runSummary: (request:Parameters<NoteAppBridge['runSummary']>[0])=>ipcRenderer.invoke('note-app:summary-run',request),
  readSummary: (request:Parameters<NoteAppBridge['readSummary']>[0])=>ipcRenderer.invoke('note-app:summary-read',request),
  approveSummary: (request:Parameters<NoteAppBridge['approveSummary']>[0])=>ipcRenderer.invoke('note-app:summary-approve',request),
  rejectSummary: (request:Parameters<NoteAppBridge['rejectSummary']>[0])=>ipcRenderer.invoke('note-app:summary-reject',request),
  cancelSummary: (request:Parameters<NoteAppBridge['cancelSummary']>[0])=>ipcRenderer.invoke('note-app:summary-cancel',request),
  getPhase1Options: ()=>ipcRenderer.invoke('note-app:phase1-options'),
  previewNoteLink: (request:Parameters<NoteAppBridge['previewNoteLink']>[0])=>ipcRenderer.invoke('note-app:note-link-preview',request),
  confirmNoteLink: (request:Parameters<NoteAppBridge['confirmNoteLink']>[0])=>ipcRenderer.invoke('note-app:note-link-confirm',request),
  cancelNoteLink: (request:Parameters<NoteAppBridge['cancelNoteLink']>[0])=>ipcRenderer.invoke('note-app:note-link-cancel',request),
  onSummary: (listener:Parameters<NoteAppBridge['onSummary']>[0])=>{
    if(typeof listener!=='function')throw new Error('Expected summary listener');
    const handler=(_event:Electron.IpcRendererEvent,view:Parameters<typeof listener>[0])=>listener(view);
    ipcRenderer.on('note-app:summary-changed',handler);return ()=>ipcRenderer.removeListener('note-app:summary-changed',handler);
  },
  onLiveState: (listener: Parameters<NoteAppBridge['onLiveState']>[0]) => {
    if(typeof listener!=='function') throw new Error('Expected state listener');
    const handler=(_event: Electron.IpcRendererEvent,state: Parameters<typeof listener>[0])=>listener(state);
    ipcRenderer.on('note-app:live-changed',handler);
    return ()=>ipcRenderer.removeListener('note-app:live-changed',handler);
  },
});
contextBridge.exposeInMainWorld('noteApp', bridge);
