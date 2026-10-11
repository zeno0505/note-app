import type {ModelRetryProposal} from './model-retry';
import type {ProjectModelSelection,RecentSummaryTasks} from '../summary/reading/recent-tasks';
import type {ProjectModelView} from '../main/project-model';
import type {SummaryAutomationView,SummaryConsentProposal,SummaryConsentBinding} from './summary-automation';
export interface SummarySelectionRequest {workstreamId:string;selection:ProjectModelSelection}
export interface SummaryReviewView {model:ProjectModelView;automation:SummaryAutomationView;recent:RecentSummaryTasks;tasks:{id:string;title:string|null;status:string|null}[]}
export interface SummaryTransferProposal {ticketId:string;expiresAt:number;binding:SummaryConsentBinding;selection:ProjectModelSelection}
export type SummaryRunAuthority={transferTicketId:string;useRememberedConsent?:never}|{useRememberedConsent:true;transferTicketId?:never};
export interface SummaryRetryProposal extends ModelRetryProposal {transferBinding:SummaryConsentBinding}
export interface SummaryReviewBridge {
 prepareSummaryTransfer(request:SummarySelectionRequest):Promise<SummaryTransferProposal>;
 cancelSummaryTransfer(request:{ticketId:string}):Promise<void>;
 prepareSummaryRetry(request:SummarySelectionRequest):Promise<SummaryRetryProposal>;
 runSummaryRetry(request:{ticketId:string;transferConfirmed:true;oneCallConfirmed:true}):Promise<ProjectModelView>;
 cancelSummaryRetry(request:{ticketId:string}):Promise<void>;
 getSummaryReview(request:SummarySelectionRequest):Promise<SummaryReviewView>;
 summarizeSelection(request:SummarySelectionRequest&{transferConfirmed:true}&SummaryRunAuthority):Promise<SummaryReviewView>;
 cancelSummarySelection(request:SummarySelectionRequest):Promise<SummaryReviewView>;
 selectActiveSummaryProject(request:{workstreamId:string|null}):Promise<void>;
 prepareSummaryConsent(request:{workstreamId:string}):Promise<SummaryConsentProposal>;
 confirmSummaryConsent(request:{ticketId:string;recurringTransferConfirmed:true;usageConfirmed:true;autoEnabled:boolean}):Promise<SummaryAutomationView>;
 revokeSummaryConsent(request:{workstreamId:string}):Promise<SummaryAutomationView>;
 setSummaryAuto(request:{workstreamId:string;enabled:boolean}):Promise<SummaryAutomationView>;
}
