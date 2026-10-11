export const MODEL_PROCESS_CODES=['model_exited_unsuccessfully','model_json_invalid','model_result_rejected','model_result_incomplete','model_cleanup_unverified'] as const;
export interface ModelProcessInfo {exitCode:number|null;signal:'none'|'SIGTERM'|'SIGKILL'|'other';durationMs:number;outputBytes:number;stderrBytes:number;cleanup:'verified'|'unverified'}
export class ModelProcessFailure extends Error {
 constructor(readonly code:typeof MODEL_PROCESS_CODES[number],readonly processInfo:ModelProcessInfo){super(code);}
}
