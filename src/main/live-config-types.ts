import type { AllowedNoteScope } from '../collector/notes';
import type { LiveConfigurationView } from '../shared/live';
import type { ExcerptRegistration } from '../summary/context/registered';
/** Trusted local startup file only. Never accepted through renderer IPC. */
export interface LiveConfiguration {
  schemaVersion: 1;
  orcaExecutablePath: string;
  codeburnExecutablePath?: string;
  localHostId?: string;
  noteScopes: AllowedNoteScope[];
  dagQuery?: {pythonPath: string; queryScriptPath: string};
  noteLink?: {gitExecutablePath: string; allowedCommonGitDirs: string[]};
  summarySelections: {scopeId: string; dagRelativePath: string; taskIds: string[]; excerpts?: ExcerptRegistration[]}[];
}
export interface LoadedLiveConfiguration {
  configuration: LiveConfiguration | null;
  view: LiveConfigurationView;
}
