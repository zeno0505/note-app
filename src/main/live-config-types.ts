import type { AllowedNoteScope } from '../collector/notes';
import type { LiveConfigurationView } from '../shared/live';
import type { ExcerptRegistration } from '../summary/context/registered';
/** Trusted local startup file only. Never accepted through renderer IPC. */
export interface LiveConfiguration {
  schemaVersion: 1;
  orcaExecutablePath: string;
  codeburnExecutablePath?: string;
  /** Explicit approval enables only the compiled public note-app pack and manual action. */
  publicModelClaudePath?: string;
  localHostId?: string;
  noteScopes: AllowedNoteScope[];
  dagQuery?: {pythonPath: string; queryScriptPath: string};
  noteLink?: {gitExecutablePath: string; allowedCommonGitDirs: string[]};
  summarySelections: {scopeId: string; dagRelativePath: string; taskIds: string[]; excerpts?: ExcerptRegistration[]}[];
  /** Exact read-only worktree document registration; independent of model context. */
  readingDocuments?: {scopeId:string;dagRelativePath:string;worktreePath:string;excerpts:ExcerptRegistration[]}[];
  /** Public note-app only. Exact startup registration, not a renderer path or token. */
  publicGitHub?: {scopeId:string;dagRelativePath:string;worktreePath:string;branch:string}[];
}
export interface LoadedLiveConfiguration {
  configuration: LiveConfiguration | null;
  view: LiveConfigurationView;
}
