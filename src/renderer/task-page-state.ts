import {reactive} from 'vue';
const pages=new WeakMap<object,{page:number;size:number}>();
/** Per-workspace session state survives tab unmounts without changing disk schema. */
export function taskPageState(workspace:object){let state=pages.get(workspace);if(!state){state=reactive({page:1,size:50});pages.set(workspace,state);}return state;}
