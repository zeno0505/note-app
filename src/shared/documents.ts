import type {EvidenceList} from './evidence';

/** Read-only capabilities. IDs are main-owned and never accepted as filesystem paths. */
export interface ProjectDocumentCatalog {
  catalogId: string;
  revision: string;
  scopeLabel: string;
  rootDirectoryId: string;
  observedAt: string;
}
export type DocumentRelationshipKind = 'task-declaration' | 'task-record' | 'project-context' | 'project-link' | 'catalog';
export interface DocumentRelationship {
  kind: DocumentRelationshipKind;
  label: string;
  taskId?: string;
  field?: 'design' | 'discussion';
  originalReference?: string;
  anchor?: string | null;
  /** DAG hash identifies the declaration, never the referenced document content. */
  dagSourceHash?: string;
  declarationSourceHash?: string;
  observedAt: string;
  verification: 'not-assessed';
}
export interface ProjectDocumentEntry {
  id: string;
  kind: 'directory' | 'file';
  name: string;
  relativePath: string;
  scopeLabel: string;
  /** Stable lookup key only; never an authorization capability. */
  navigationKey: string;
  format?: 'markdown' | 'png' | 'yaml' | 'json';
  relationships: DocumentRelationship[];
}
export interface ProjectDocumentListing {
  catalogId: string;
  revision: string;
  directoryId: string;
  breadcrumbs: {id:string;name:string}[];
  entries: ProjectDocumentEntry[];
  nextCursor: string | null;
  partial: boolean;
  omissions: string[];
  observedAt: string;
}
export interface ProjectDocumentListRequest {catalogId:string;directoryId:string;query?:string;cursor?:string;refresh?:true}
export interface ProjectDocumentBridge {
  prepareProjectDocuments(request:{workstreamId:string}):Promise<ProjectDocumentCatalog>;
  listProjectDocuments(request:ProjectDocumentListRequest):Promise<ProjectDocumentListing>;
  openCatalogDocument(request:{catalogId:string;documentId:string}):Promise<EvidenceList>;
  releaseProjectDocuments(request:{catalogId:string}):Promise<void>;
}
