import type { NoteLinkPreviewRequest, NoteLinkPreviewResult, NoteLinkConfirmRequest, NoteLinkConfirmResult } from './note-link-workflow';
export interface Phase1Options {
  noteLinkConfigured: boolean;
  noteLinkMessage: string;
  noteScopes: {scopeId: string; scopePath: string}[];
  summaryTransport: 'blocked';
}
export interface NoteLinkBridge {
  getPhase1Options(): Promise<Phase1Options>;
  previewNoteLink(request: NoteLinkPreviewRequest): Promise<NoteLinkPreviewResult>;
  confirmNoteLink(request: NoteLinkConfirmRequest): Promise<NoteLinkConfirmResult>;
  cancelNoteLink(request: {proposalId: string}): Promise<{cancelled: boolean}>;
}
