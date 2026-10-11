import {describe,it,expect} from 'vitest';
import {parseSummaryModelIdentity} from '../../src/main/summary-model-identity';
const base={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro',email:'synthetic@example.test'};
describe('recurring account identity',()=>{
 it('binds an explicitly observable existing account without credentials',()=>{const result=parseSummaryModelIdentity(base);expect(result.accountId).toMatch(/^[a-f0-9]{64}$/);expect(result.accountLabel).toBe(base.email);expect(result.modelPolicy).toContain('default-clean-settings');});
 it('fails closed when authentication has no account identity',()=>{expect(()=>parseSummaryModelIdentity({...base,email:undefined})).toThrow();});
 it('invalidates recipient identity on account or organization change',()=>{const first=parseSummaryModelIdentity(base).accountId;expect(parseSummaryModelIdentity({...base,email:'other@example.test'}).accountId).not.toBe(first);expect(parseSummaryModelIdentity({...base,orgId:'other-org'}).accountId).not.toBe(first);});
 it('rejects API authentication and malformed identity',()=>{expect(()=>parseSummaryModelIdentity({...base,authMethod:'api_key'})).toThrow();expect(()=>parseSummaryModelIdentity({...base,email:'bad\nidentity'})).toThrow();});
});
