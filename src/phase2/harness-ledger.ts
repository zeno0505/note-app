/** Versioned declarations, never certification of execution or human approval. */
export interface HarnessLedgerHeader {
  schema: number | string | null; profile: string | null; ledgerKey: string | null;
  state: 'supported' | 'unsupported-format' | 'schema-missing';
  features: string[]; observedFeatures: string[]; unsupportedFeatures: string[];
}
export interface HarnessTaskDeclaration {
  acceptance: Record<string,unknown>[]; judgment: Record<string,unknown> | null;
  verification: Record<string,unknown>[]; block: Record<string,unknown> | null;
  who: string | null; question: string | null; omissions: number;
  verificationState: '검사 결과 연결 미확인';
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):string|null=>typeof v==='string'&&v.length<=4096&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)?v:null;
const KNOWN=new Set(['acceptance','judgment','type','verify_by','verification','block','exception','who','question','depends_kind','legacy_ref','supersedes','recurring','made_by']);
export function projectHarnessDeclarations(raw:Record<string,unknown>,tasks:{id:string;harness?:HarnessTaskDeclaration}[]):HarnessLedgerHeader|undefined {
  if(!object(raw.ledger))return undefined; // Older pinned transports remain valid.
  const head=raw.ledger, schema=typeof head.schema==='number'||typeof head.schema==='string'?head.schema:head.schema==null?null:'[지원하지 않는 schema 값]';
  const features=Array.isArray(head.features)?head.features.filter((f):f is string=>typeof f==='string'&&f.length<=128).slice(0,100):[];
  const observed=new Set<string>();
  const header:HarnessLedgerHeader={schema,profile:text(head.profile),ledgerKey:text(head.ledger_key),
    state:schema===null?'schema-missing':schema===2||schema===3?'supported':'unsupported-format',
    features,observedFeatures:[],unsupportedFeatures:[...features.filter(f=>!KNOWN.has(f)),...(head.features!=null&&(!Array.isArray(head.features)||head.features.length>100||head.features.some(f=>typeof f!=='string'||f.length>128))?['[features 형식 미지원]']:[])]};
  if(header.state==='unsupported-format')return header;
  if(!Array.isArray(raw.ledgerTasks)||raw.ledgerTasks.length!==tasks.length)throw Error('Invalid harness task transport.');
  const byId=new Map(tasks.map(t=>[t.id,t])),seen=new Set<string>();
  for(const value of raw.ledgerTasks){
    if(!object(value)||typeof value.id!=='string'||seen.has(value.id)||!byId.has(value.id))throw Error('Invalid harness task binding.');
    seen.add(value.id);
    for(const key of Object.keys(value))if(key!=='id'&&value[key]!=null)observed.add(key);
    if(schema!==3&&header.profile!=='v2+v3-fields')continue;
    let omissions=0,total=0;
    const record=(v:unknown):Record<string,unknown>|null=>{
      if(v==null)return null;
      if(!object(v)){omissions++;return null;}
      try{const json=JSON.stringify(v);if(json.length>32768||total+json.length>131072){omissions++;return null;}total+=json.length;return JSON.parse(json) as Record<string,unknown>;}catch{omissions++;return null;}
    };
    const records=(v:unknown):Record<string,unknown>[]=>{
      if(v==null)return [];if(!Array.isArray(v)){omissions++;return [];}
      omissions+=Math.max(0,v.length-100);return v.slice(0,100).flatMap(item=>{if(item==null){omissions++;return [];}const result=record(item);return result?[result]:[];});
    };
    byId.get(value.id)!.harness={acceptance:records(value.acceptance),judgment:record(value.judgment),verification:records(value.verification),block:record(value.block),
      who:text(value.who),question:text(value.question),omissions,verificationState:'검사 결과 연결 미확인'};
  }
  header.observedFeatures=[...observed].sort();
  return header;
}
