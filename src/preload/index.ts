import {parseProjectCreationRequest} from '../shared/project-creation';
import {parseConfirmProjectDagRequest,parseCancelProjectDagRequest} from '../shared/project-dag';
import {parseOrcaProjectOpenRequest} from '../shared/orca-project-open';
import {parseResolveProjectWorkspaceRequest} from '../shared/project-workspaces';
import { contextBridge, ipcRenderer } from 'electron';
import type { NoteAppBridge } from '../shared/bridge';
const bridge: NoteAppBridge = Object.freeze({
  getProjectCreationAvailability:()=>ipcRenderer.invoke('note-app:project-creation-availability'),
  prepareProjectCreation:(request:Parameters<NoteAppBridge['prepareProjectCreation']>[0])=>ipcRenderer.invoke('note-app:project-creation-prepare',parseProjectCreationRequest(request)),
  confirmProjectCreation:(request:Parameters<NoteAppBridge['confirmProjectCreation']>[0])=>ipcRenderer.invoke('note-app:project-creation-confirm',parseConfirmProjectDagRequest(request)),
  cancelProjectCreation:(request:Parameters<NoteAppBridge['cancelProjectCreation']>[0])=>ipcRenderer.invoke('note-app:project-creation-cancel',parseCancelProjectDagRequest(request)),
  getOrcaProjectOpenAvailability:(request:Parameters<NoteAppBridge['getOrcaProjectOpenAvailability']>[0])=>ipcRenderer.invoke('note-app:orca-project-open-availability',parseOrcaProjectOpenRequest(request)),
  openProjectInOrca:(request:Parameters<NoteAppBridge['openProjectInOrca']>[0])=>ipcRenderer.invoke('note-app:orca-project-open',parseOrcaProjectOpenRequest(request)),
  getProjectWorkspaceOptions:()=>ipcRenderer.invoke('note-app:project-workspaces'),
  resolveProjectWorkspace:(request:Parameters<NoteAppBridge['resolveProjectWorkspace']>[0])=>ipcRenderer.invoke('note-app:project-workspace-resolve',parseResolveProjectWorkspaceRequest(request)),
  listProjectDrafts:()=>ipcRenderer.invoke('note-app:project-drafts-list'),
  saveProjectDraft:(request:Parameters<NoteAppBridge['saveProjectDraft']>[0])=>ipcRenderer.invoke('note-app:project-draft-save',request),
  confirmAppBoot:()=>ipcRenderer.invoke('note-app:boot-ready'),
  getUpdateState:()=>ipcRenderer.invoke('note-app:update-state'),
  checkUpdate:()=>ipcRenderer.invoke('note-app:update-check'),
  prepareUpdate:()=>ipcRenderer.invoke('note-app:update-prepare'),
  cancelUpdate:()=>ipcRenderer.invoke('note-app:update-cancel'),
  deferUpdate:()=>ipcRenderer.invoke('note-app:update-defer'),
  installUpdate:()=>ipcRenderer.invoke('note-app:update-install'),
  dismissUpdateOutcome:()=>ipcRenderer.invoke('note-app:update-dismiss-outcome'),
  onUpdateState:(listener:Parameters<NoteAppBridge['onUpdateState']>[0])=>{
    if(typeof listener!=='function')throw new Error('Expected update listener');
    const handler=(_event:Electron.IpcRendererEvent,state:Parameters<typeof listener>[0])=>listener(state);
    ipcRenderer.on('note-app:update-changed',handler);
    return ()=>ipcRenderer.removeListener('note-app:update-changed',handler);
  },
  prepareModelRetry:(request:Parameters<NoteAppBridge['prepareModelRetry']>[0])=>ipcRenderer.invoke('note-app:model-retry-prepare',request),
  cancelModelRetry:(request:Parameters<NoteAppBridge['cancelModelRetry']>[0])=>ipcRenderer.invoke('note-app:model-retry-cancel',request),
  runModelRetry:(request:Parameters<NoteAppBridge['runModelRetry']>[0])=>ipcRenderer.invoke('note-app:model-retry-run',request),
  getAppMemory:()=>ipcRenderer.invoke('note-app:app-memory'),
  getWorkspaceState:(request:Parameters<NoteAppBridge['getWorkspaceState']>[0])=>ipcRenderer.invoke('note-app:workspace-state-get',request),
  setWorkspaceState:(request:Parameters<NoteAppBridge['setWorkspaceState']>[0])=>ipcRenderer.invoke('note-app:workspace-state-set',request),
  releaseTaskEvidence:(request:Parameters<NoteAppBridge['releaseTaskEvidence']>[0])=>ipcRenderer.invoke('note-app:evidence-release',request),
  prepareTaskEvidence:(request:Parameters<NoteAppBridge['prepareTaskEvidence']>[0])=>ipcRenderer.invoke('note-app:evidence-prepare',request),
  readTaskEvidence:(request:Parameters<NoteAppBridge['readTaskEvidence']>[0])=>ipcRenderer.invoke('note-app:evidence-read',request),
  setSummaryPrefix:(request:Parameters<NoteAppBridge['setSummaryPrefix']>[0])=>ipcRenderer.invoke('note-app:summary-prefix',request),
  getProjectModelState:(request:Parameters<NoteAppBridge['getProjectModelState']>[0])=>ipcRenderer.invoke('note-app:project-model-state',request),
  summarizeProjectModel:(request:Parameters<NoteAppBridge['summarizeProjectModel']>[0])=>ipcRenderer.invoke('note-app:project-model-run',request),
  cancelProjectModel:(request:Parameters<NoteAppBridge['cancelProjectModel']>[0])=>ipcRenderer.invoke('note-app:project-model-cancel',request),
  getPublicModelReview:()=>ipcRenderer.invoke('note-app:public-model-review'),
  getPublicModelState:()=>ipcRenderer.invoke('note-app:public-model-state'),
  summarizePublicModel:()=>ipcRenderer.invoke('note-app:public-model-run'),
  cancelPublicModel:()=>ipcRenderer.invoke('note-app:public-model-cancel'),
  getEnvironment: () => ipcRenderer.invoke('note-app:environment'),
  selectNoteReconnect:(request:Parameters<NoteAppBridge['selectNoteReconnect']>[0])=>ipcRenderer.invoke('note-app:note-reconnect-select',request),
  cancelNoteReconnect:(request:Parameters<NoteAppBridge['cancelNoteReconnect']>[0])=>ipcRenderer.invoke('note-app:note-reconnect-cancel',request),
  confirmNoteReconnect:(request:Parameters<NoteAppBridge['confirmNoteReconnect']>[0])=>ipcRenderer.invoke('note-app:note-reconnect-confirm',request),
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
