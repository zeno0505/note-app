/** Exact DAG ID grammar: prefix + hyphen + numeric task number and numeric subtasks, with optional letter suffixes. */
export function taskPrefix(id:string):string|null {
  return /^([A-Za-z][A-Za-z0-9_]*)-\d+[A-Za-z]*(?:-\d+[A-Za-z]*)*$/.exec(id)?.[1]??null;
}
export interface SummaryPrefixScope {
  sourceHash:string;selected:string; available:{prefix:string;count:number}[];
  total:number; selectedCount:number; otherCount:number; unparsedCount:number;
  taskSelection:SummaryTaskSelection;
  dependencies:{id:string;scope:'internal'|'external';status:string|null}[];
}

export interface SummaryTaskSelection {
  mode:"representative"|"explicit";taskIds:string[];omittedCount:number;missingIds:string[];
  reasons:{id:string;reason:string;waitingCount:number}[];
}
