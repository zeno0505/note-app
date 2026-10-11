import {createHash} from 'node:crypto';
/** A policy identity, not a claim that the provider's default model is immutable. */
export const SUMMARY_MODEL_POLICY='claude-subscription-default-clean-settings-v1';
export interface SummaryModelIdentity {provider:'Anthropic Claude';accountId:string;accountLabel:string;modelPolicy:string}
export function parseSummaryModelIdentity(value:unknown):SummaryModelIdentity {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('AI account identity unavailable');
  const v=value as Record<string,unknown>;
  if(v.loggedIn!==true||v.authMethod!=='claude.ai'||v.apiProvider!=='firstParty'||typeof v.subscriptionType!=='string'||!v.subscriptionType)throw Error('Existing subscription account required');
  const field=['accountUuid','userId','email'].find(key=>typeof v[key]==='string'&&!!(v[key] as string).trim());
  if(!field)throw Error('AI account identity unavailable; recurring transmission disabled');
  const identifier=v[field] as string;
  if(identifier.length>512||/[\u0000-\u001f\u007f]/u.test(identifier))throw Error('Invalid AI account identity');
  const organization=typeof v.orgId==='string'?v.orgId:'';
  if(organization.length>512||/[\u0000-\u001f\u007f]/u.test(organization))throw Error('Invalid AI organization identity');
  const accountId=createHash('sha256').update(JSON.stringify([field,identifier,organization,v.subscriptionType])).digest('hex');
  const accountLabel=typeof v.email==='string'&&v.email.length<=320&&!/[\u0000-\u001f\u007f]/u.test(v.email)?v.email:'연결된 Claude 계정 · '+accountId.slice(0,8);
  return {provider:'Anthropic Claude',accountId,accountLabel,modelPolicy:SUMMARY_MODEL_POLICY};
}
