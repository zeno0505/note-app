import type {ModelRetryBridge} from './model-retry';
import type {NoteReconnectBridge} from './note-reconnect';
import type { WorkspaceSnapshot } from '../domain';
import type { LiveWorkspaceView } from './live';
import type { SummaryWorkflowBridge } from './summary-workflow';
import type { NoteLinkBridge } from './phase1-options';
import type {ReadRootsBridge} from './read-roots';
export interface AppEnvironment {
  version: string;
  buildSha?:string|null;
  buildNumber?:string|null;
  installationRole?:'development'|'user'|'verification'|'blocked';
  installationPath?:string;
  canonicalInstallationPath?:string;
  platform: string;
  dataMode: 'disabled' | 'configured';
  summaryBackend: 'unconfigured';
  capabilities: {realOrca:boolean; noteWrites:boolean; remoteSummary:false};
}
export interface NoteAppBridge extends SummaryWorkflowBridge, NoteLinkBridge, ReadRootsBridge, NoteReconnectBridge, ModelRetryBridge {
  getAppMemory():Promise<import('./app-memory').AppMemoryView>;
  getWorkspaceState(request:{workstreamId:string}):Promise<import('./workspace-state').TaskWorkspaceState|null>;
  setWorkspaceState(request:{workstreamId:string;state:import('./workspace-state').TaskWorkspaceState}):Promise<void>;
  releaseTaskEvidence(request:{sessionId:string}):Promise<void>;
  prepareTaskEvidence(request:import('./evidence').EvidenceSelection):Promise<import('./evidence').EvidenceList>;
  readTaskEvidence(request:{sessionId:string;evidenceId:string;expectedSourceHash:string|null}):Promise<import('./evidence').EvidenceReadView>;
  setSummaryPrefix(request:{workstreamId:string;prefix:string;taskIds?:string[]}):Promise<LiveWorkspaceView>;
  getProjectModelState(request:{workstreamId:string}):Promise<import('../main/project-model').ProjectModelView>;
  summarizeProjectModel(request:{workstreamId:string;transferConfirmed:true}):Promise<import('../main/project-model').ProjectModelView>;
  cancelProjectModel(request:{workstreamId:string}):Promise<import('../main/project-model').ProjectModelView>;
  getPublicModelReview():Promise<import('../summary/reading/model-reading-storage').LatestModelReadingView>;
  getPublicModelState():Promise<import('../main/public-model').PublicModelView>;
  summarizePublicModel():Promise<import('../main/public-model').PublicModelView>;
  cancelPublicModel():Promise<import('../main/public-model').PublicModelView>;
  getEnvironment(): Promise<AppEnvironment>;
  loadDemo(request: {scenario:'normal'|'empty'|'failure'}): Promise<WorkspaceSnapshot>;
  getLiveState(): Promise<LiveWorkspaceView>;
  connectLive(): Promise<LiveWorkspaceView>;
  refreshLive(): Promise<LiveWorkspaceView>;
  summarizeNow(): Promise<LiveWorkspaceView>;
  disconnectLive(): Promise<LiveWorkspaceView>;
  openProjectDocument(request:{workstreamId:string;linkId:string}):Promise<void>;
  confirmProjectConnection(request:{workstreamId:string;candidateId:string}):Promise<LiveWorkspaceView>;
  setProjectStatus(request:{projectId:string;status:'active'|'completed';expectedStatus:'active'|'completed'}):Promise<LiveWorkspaceView>;
  onLiveState(listener: (state: LiveWorkspaceView)=>void): ()=>void;
}
declare global { interface Window { noteApp: NoteAppBridge } }
