/** Read-only explanations, independent of model candidates and user approvals. */
export interface ReadingSource {
  kind: 'dag' | 'orca' | 'pull' | 'ci' | 'review';
  id: string;
  sha: string | null;
  sourceHash: string | null;
  observedAt: string | null;
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
  limitation: string;
}
