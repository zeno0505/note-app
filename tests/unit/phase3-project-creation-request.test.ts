import {describe,it,expect,vi} from 'vitest';
import {parseProjectCreationRequest} from '../../src/shared/project-creation';
const request=()=>({draftId:'project-draft-12345678-1234-4234-8234-123456789abc',expectedDraftRevision:1,projectPath:'example/demo/new',baseBranch:'main',verification:['npm test']});
describe('project creation form IPC',()=>{
 it('detaches bounded explicit policies without destination or commands to execute',()=>{const value=request(),parsed=parseProjectCreationRequest(value);expect(parsed).toEqual(value);value.verification.push('later');expect(parsed.verification).toEqual(['npm test']);});
 it('rejects foreign fields, sparse arrays, accessors and custom prototypes without invoking getters',()=>{const getter=vi.fn(()=>request().projectPath);for(const value of [{...request(),path:'/arbitrary'},Object.assign(Object.create({}),request()),{...request(),verification:new Array(1)},{...request(),verification:Object.assign(['test'],{extra:true})},Object.defineProperty(request(),'projectPath',{get:getter})])expect(()=>parseProjectCreationRequest(value)).toThrow();expect(getter).not.toHaveBeenCalled();});
 it.each(['/absolute','../escape','example//repo','example/./repo','example/repo/..','example\\repo'])('rejects nonlogical project path %s',projectPath=>{expect(()=>parseProjectCreationRequest({...request(),projectPath})).toThrow();});
 it('requires bounded single-line explicit verification declarations',()=>{for(const verification of [[],[''],['one\ntwo'],new Array(33).fill('x'),['a'.repeat(2049)]])expect(()=>parseProjectCreationRequest({...request(),verification})).toThrow();});
});
