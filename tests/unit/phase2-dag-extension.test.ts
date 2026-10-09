import {describe,it,expect} from 'vitest';
import {projectDagQuery} from '../../src/facts/dag-read-model/projection';
function wire(){return {readContractVersion:2,index:[{id:'X-1',status:'future'}],details:[{id:'X-1',type:'unknown-kind',description:'Declared only',acceptance_criteria:['Review'],target_files:['src/x.ts']}],phases:[{index:0,id:'P-1',title:'Design',taskIds:['X-1']}],policies:[{key:'example',decision:'not an implicit status map'}],coverage:{tasks_total:1,declared:0,required:0,uncovered_done:[],uncovered_open:[],malformed:[]}};}
describe('explicit pinned DAG v2 projection',()=>{
 it('preserves new vocabulary, phase and declarations without verification',()=>{const result=projectDagQuery(wire());expect(result.readContractVersion).toBe(2);expect(result.tasks[0]).toMatchObject({status:'future',rawType:'unknown-kind',phase:{id:'P-1',title:'Design',index:0},details:{description:'Declared only'},commitVerification:'not-performed'});});
 it('keeps unsupported details as omissions rather than asserting absence',()=>{const input=wire();input.details[0].acceptance_criteria=[{private:'shape'} as never];expect(projectDagQuery(input).tasks[0].details?.omissions).toBe(1);});
 it('rejects missing or repeated phase linkage',()=>{const input=wire();input.phases[0].taskIds=[];expect(()=>projectDagQuery(input)).toThrow();input.phases[0].taskIds=['X-1','X-1'];expect(()=>projectDagQuery(input)).toThrow();});
 it('does not expose new fields through unversioned v1',()=>{const input=wire();delete (input as Partial<typeof input>).readContractVersion;const result=projectDagQuery(input);expect(result.tasks[0].details).toBeUndefined();expect(result.policies).toBeUndefined();});
});
