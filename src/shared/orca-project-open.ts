/** A display receipt, never evidence of a model/terminal/task execution. */
export type OrcaProjectOpenFailureReason =
  | 'unavailable' | 'busy' | 'cancelled' | 'timeout' | 'unsupported_version'
  | 'selection_changed' | 'unsafe_path' | 'runtime_changed' | 'access_denied'
  | 'spawn_failed' | 'command_failed' | 'output_limit' | 'invalid_json'
  | 'invalid_schema' | 'not_opened' | 'cleanup_unverified';

export type OrcaProjectOpenResult =
  | {ok:true;opened:true}
  | {ok:false;reason:OrcaProjectOpenFailureReason;
      /** A failed receipt after dispatch cannot prove that Orca's display did not change. */
      attempted:boolean};

export interface OrcaProjectOpenAvailability {available:boolean;reason:'ready'|'unavailable'|'external-note'}
export interface OrcaProjectOpenBridge {
  getOrcaProjectOpenAvailability(request:{workstreamId:string}):Promise<OrcaProjectOpenAvailability>;
  openProjectInOrca(request:{workstreamId:string}):Promise<OrcaProjectOpenResult>;
}
export function parseOrcaProjectOpenRequest(value:unknown):{workstreamId:string}{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='workstreamId')throw Error('Orca 대상 프로젝트를 다시 선택해 주세요.');
 const id=(value as {workstreamId:unknown}).workstreamId;if(typeof id!=='string'||!id.length||id.length>4096||/[\u0000-\u001f\u007f]/u.test(id))throw Error('Orca 대상 프로젝트를 다시 선택해 주세요.');return {workstreamId:id};
}
