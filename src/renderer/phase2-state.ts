import {reactive} from 'vue';
import {defaultWorkspaceState,parseWorkspaceState,type TaskWorkspaceState} from '../shared/workspace-state';
export type {TaskWorkspaceState,WorkspaceTab} from '../shared/workspace-state';
const states = new Map<string,TaskWorkspaceState>(), loaded = new Set<string>();
/** Consent is session-only and bound to the observed mapping; no tokens, paths or source bodies are persisted. */
const scopes = new Map<string,{accepted:boolean;mappingKey:string;epoch:number;mutating:boolean}>();
export function documentScopeState(id:string) {
 let scope = scopes.get(id);
 if (!scope) { scope = reactive({accepted:false,mappingKey:'',epoch:0,mutating:false}); scopes.set(id,scope); if(scopes.size>100)scopes.delete(scopes.keys().next().value!); }
 return scope;
}
export function workspaceState(id:string):TaskWorkspaceState {const prior=states.get(id);if(prior)return prior;const state=reactive(defaultWorkspaceState());if(states.size>=100){const oldest=states.keys().next().value!;states.delete(oldest);loaded.delete(oldest);scopes.delete(oldest);}states.set(id,state);return state;}
export async function loadWorkspaceState(id:string,state:TaskWorkspaceState){if(loaded.has(id))return;const saved=await window.noteApp.getWorkspaceState({workstreamId:id});if(saved)Object.assign(state,parseWorkspaceState(saved));loaded.add(id);}
export async function saveWorkspaceState(id:string,state:TaskWorkspaceState){await window.noteApp.setWorkspaceState({workstreamId:id,state:parseWorkspaceState({...state})});}
