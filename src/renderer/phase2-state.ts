import {reactive} from 'vue';
import {defaultWorkspaceState,parseWorkspaceState,type TaskWorkspaceState} from '../shared/workspace-state';
export type {TaskWorkspaceState,WorkspaceTab} from '../shared/workspace-state';
const states=new Map<string,TaskWorkspaceState>(),loaded=new Set<string>();
export function workspaceState(id:string):TaskWorkspaceState {const prior=states.get(id);if(prior)return prior;const state=reactive(defaultWorkspaceState());if(states.size>=100){const oldest=states.keys().next().value!;states.delete(oldest);loaded.delete(oldest);}states.set(id,state);return state;}
export async function loadWorkspaceState(id:string,state:TaskWorkspaceState){if(loaded.has(id))return;const saved=await window.noteApp.getWorkspaceState({workstreamId:id});if(saved)Object.assign(state,parseWorkspaceState(saved));loaded.add(id);}
export async function saveWorkspaceState(id:string,state:TaskWorkspaceState){await window.noteApp.setWorkspaceState({workstreamId:id,state:parseWorkspaceState({...state})});}
