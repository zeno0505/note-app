import type { WorkspaceSnapshot } from '../domain';
import type { LiveWorkspaceView } from './live';
import type { SummaryWorkflowBridge } from './summary-workflow';
import type { NoteLinkBridge } from './phase1-options';
export interface AppEnvironment {
  version: string;
  platform: string;
  dataMode: 'disabled' | 'configured';
  summaryBackend: 'unconfigured';
  capabilities: {realOrca:boolean; noteWrites:boolean; remoteSummary:false};
}
export interface NoteAppBridge extends SummaryWorkflowBridge, NoteLinkBridge {
  getEnvironment(): Promise<AppEnvironment>;
  loadDemo(request: {scenario:'normal'|'empty'|'failure'}): Promise<WorkspaceSnapshot>;
  getLiveState(): Promise<LiveWorkspaceView>;
  connectLive(): Promise<LiveWorkspaceView>;
  refreshLive(): Promise<LiveWorkspaceView>;
  disconnectLive(): Promise<LiveWorkspaceView>;
  onLiveState(listener: (state: LiveWorkspaceView)=>void): ()=>void;
}
declare global { interface Window { noteApp: NoteAppBridge } }
