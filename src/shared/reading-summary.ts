/** Read-only explanations, independent of model candidates and user approvals. */
export interface ReadingSource {
  kind: 'dag' | 'orca' | 'pull' | 'ci' | 'review' | 'git' | 'document';
  id: string;
  sha: string | null;
  sourceHash: string | null;
  observedAt: string | null;
  document?: {relativePath:string;lineStart:number;lineEnd:number;environment:string|null;result:'passed'|'failed'|'not-run'|null;references:string[]};
}
export interface ReadingParagraph {
  text: string;
  basis: 'declaration' | 'observation' | 'proposal' | 'unknown';
  sources: ReadingSource[];
}
export interface ReadingSection {
  id: 'implemented' | 'next' | 'evidence' | 'decisions';
  title: string;
  paragraphs: ReadingParagraph[];
  recordState?: 'recorded'|'not-applicable'|'unrecorded'|'conflicting';
  designState?: 'discussion'|'designed'|'not-applicable'|'unrecorded'|'conflicting';
}
export interface ReadingSummary {
  kind: 'rules-only';
  workstreamId: string;
  fingerprint: string;
  revision: number;
  generatedAt: string;
  checkedAt: string;
  changed: boolean;
  partial: boolean;
  sections: ReadingSection[];
  dagMismatches?: {taskId:string;reason:string;sources:ReadingSource[]}[];
  limitation: string;
}
