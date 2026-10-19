import path from 'node:path';
import {createEvidenceReader,type EvidenceResult} from '../../phase2/evidence';
import {harnessFile} from '../../phase2/harness-yaml';
import {resolveHarnessLink,type HarnessFile,type HarnessLinkResult} from '../../phase2/harness-links';
import {pinDocumentDirectory,safeDocumentRelativePath} from './catalog';
import {inspectDocumentFile} from './relationships';
import type {DescriptorMetadataTransport} from './descriptor-metadata';
export type HarnessReferenceResult=HarnessLinkResult|{result:'denied'};
export interface RegisteredHarnessSnapshot {
  enabled:boolean; resolve(link:string):HarnessReferenceResult;
  document(result:HarnessReferenceResult):{relativePath:string;anchor:string|null}|null;
  omissions:string[];
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Scan only an already-authorized root. No symlink traversal, network or scripts.
 * Incomplete/changed indexes cannot establish uniqueness or absence. */
export async function readRegisteredHarnessSnapshot(options:{root:string;from:string;authorize:()=>Promise<boolean>;signal:AbortSignal;metadata?:DescriptorMetadataTransport;trackRead?:(operation:()=>Promise<EvidenceResult>)=>Promise<EvidenceResult>}):Promise<RegisteredHarnessSnapshot>{
 const files=new Map<string,HarnessFile>(),actual=new Map<string,string>(),omissions:string[]=[];
 let complete=true,denied=false,enabled=false,total=0,entries=0,directories=0;
 const active=()=>{if(options.signal.aborted)throw Error('Harness snapshot cancelled');};
 async function allowed(){active();if(!await options.authorize()){denied=true;throw Error('Harness snapshot denied');}active();}
 async function read(relativePath:string):Promise<HarnessFile|null>{
  await allowed();const reader=await createEvidenceReader({scopeId:'harness-snapshot',canonicalRootPath:options.root,registrations:[{id:'file',relativePath}],authorize:options.authorize});
  try {const descriptor=reader.list()[0],readOperation=()=>reader.read({evidenceId:descriptor.evidenceId,expectedSourceHash:null},options.signal),result=await (options.trackRead?options.trackRead(readOperation):readOperation());
   if(!result.ok){if(result.code==='permission-denied')denied=true;return null;}
   if(result.content.kind!=='text'||Buffer.byteLength(result.content.text)>1024*1024||(total+=Buffer.byteLength(result.content.text))>4*1024*1024)return null;
   return harnessFile(result.content.text,relativePath);
  }finally{reader.retire();}
 }
 const response=():RegisteredHarnessSnapshot=>({enabled:enabled||denied,omissions,resolve:link=>{
  if(denied)return {result:'denied'};if(!complete)return {result:'unsupported',warnings:['snapshot-incomplete']};
  // Validate the explicitly named ledger before task lookup, including missing IDs
  // and ledgers without ledger_key. Interpretation must not report false absence.
  if(link.startsWith('[[')&&link.endsWith(']]'))try{
   const name=decodeURIComponent(link.slice(2,-2).replace(/\\\|/g,'|').split('|')[0]).split('#')[0];
   if(/(?:^|\/)dag(?:\.md|\.yaml)?$/u.test(name)){
    const probe=resolveHarnessLink(files,options.from,'[['+encodeURIComponent(name).replace(/%2F/g,'/')+']]');
    const data=probe.target?.file?files.get(probe.target.file)?.data:null;
    if(probe.result==='resolved'&&(!object(data)||data.schema!==2&&data.schema!==3))return {result:'unsupported',warnings:['unsupported-schema']};
   }
  }catch{return {result:'unsupported'};}
  const result=resolveHarnessLink(files,options.from,link);
  if(result.result==='resolved'||result.result==='resolved(archived)'){
   let file=result.target?.file;
   if(!file&&result.target?.ledger){const matching=[...files].filter(([name,value])=>(name==='dag.yaml'||name.endsWith('/dag.yaml'))&&object(value.data)&&value.data.ledger_key===result.target!.ledger);if(matching.length>1)return {result:'ambiguous'};file=matching[0]?.[0];}
   if(file){let dir=path.posix.dirname(file);if(dir==='.')dir='';for(;;){const ledger=files.get(dir?dir+'/dag.yaml':'dag.yaml');if(ledger){if(!object(ledger.data)||ledger.data.schema!==2&&ledger.data.schema!==3)return {result:'unsupported',warnings:['unsupported-schema']};break;}if(!dir)break;dir=path.posix.dirname(dir);if(dir==='.')dir='';}}
  }return result;
 },document:result=>{
  if(result.result!=='resolved')return null;
  let file=result.target?.file,anchor=result.target?.anchor??result.target?.task??null;
  if(!file&&result.target?.task){const ledgers=[...files].filter(([name,value])=>name.endsWith('dag.yaml')&&object(value.data)&&value.data.ledger_key===result.target!.ledger);if(ledgers.length!==1)return null;file=ledgers[0][0];}
  if(file?.endsWith('dag.yaml')&&files.has(file.slice(0,-4)+'md'))file=file.slice(0,-4)+'md';
  // An AC is not a heading unless the actual renderer has supplied that anchor.
  if(result.target?.ac)anchor=result.target.task+'/'+result.target.ac;
  return file&&actual.has(file)?{relativePath:actual.get(file)!,anchor}:null;
 }});
 try {
  if(!safeDocumentRelativePath(options.from))throw Error('Unsafe source');
  // Determine format from the nearest enclosing ledger before any recursive scan.
  let ancestor=false;let dir=path.posix.dirname(options.from);if(dir==='.')dir='';
  for(;;){const candidate=dir?dir+'/dag.yaml':'dag.yaml';
   await allowed();const state=await inspectDocumentFile(options.root,candidate,options.signal,options.metadata);
   if(state!=='missing'){ancestor=true;
    enabled=true;if(state!=='present'){complete=false;return response();}
    const ledger=await read(candidate),data=ledger?.data;
    if(!object(data)){complete=false;return response();}
    enabled=data.schema!=null&&(data.schema!==2||data.profile==='v2+v3-fields');
    if(data.schema!==3&&!(data.schema===2&&data.profile==='v2+v3-fields')){complete=false;return response();}
    break;
   }
   if(!dir)break;dir=path.posix.dirname(dir);if(dir==='.')dir='';
  }
  if(ancestor&&!enabled)return response();
  if(!ancestor)enabled=true; // Descendant ledgers may be referenced from a repository README.
  const pins:Awaited<ReturnType<typeof pinDocumentDirectory>>[]=[];
  const stamps:{pin:Awaited<ReturnType<typeof pinDocumentDirectory>>;name:string;stamp:string}[]=[];
  const stamp=(stat:{dev:number|string;ino:number|string;size:number;mtimeMs:number;ctimeMs:number})=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  const scan=async(relative:string,depth:number,expected?:string,openedPath?:string):Promise<void>=>{
   await allowed();if(depth>16||++directories>64)throw Error('Snapshot directory limit');
   const pinned=await pinDocumentDirectory(path.join(options.root,relative),active,expected,openedPath,options.metadata,options.signal);
   pins.push(pinned);
   {const listing=await pinned.list(1024);entries+=listing.examinedCount;if(listing.partial||entries>2048)throw Error('Snapshot entry limit');
    for(const {name,stat}of listing.entries){active();const file=relative?relative+'/'+name:name;if(!safeDocumentRelativePath(file))continue;
     if(stat.isSymbolicLink()){complete=false;if(!omissions.length)omissions.push('심볼릭 링크가 있어 v3 인덱스의 완전성을 확인하지 못했습니다.');continue;}
     if(stat.isDirectory()){await scan(file,depth+1,`${stat.dev}:${stat.ino}:${stat.mode}`,pinned.descriptorPath?path.join(pinned.descriptorPath,name):undefined);continue;}
     if(!/\.(?:md|ya?ml)$/u.test(name))continue;
     if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024||files.size>=256)throw Error('Snapshot file limit');
     stamps.push({pin:pinned,name,stamp:stamp(stat)});
     const normalized=file.normalize('NFC');if(actual.has(normalized))throw Error('NFC collision');
     const value=await read(file);if(!value)throw Error('Snapshot file unavailable');files.set(normalized,value);actual.set(normalized,file);
    }await pinned.verify();
   }
  };
  try {await scan('',0);for(const item of stamps)if(stamp(await item.pin.stat(item.name))!==item.stamp)throw Error('Snapshot changed');for(const pin of pins)await pin.verify();await allowed();if(!ancestor)enabled=[...files].some(([name,file])=>(name==='dag.yaml'||name.endsWith('/dag.yaml'))&&object(file.data)&&file.data.schema!=null&&(file.data.schema!==2||file.data.profile==='v2+v3-fields'));}
  finally{for(const pin of pins.reverse())await pin.handle.close();}
 }catch{active();complete=false;omissions.push(denied?'문서 읽기 권한이 철회되었습니다.':'v3 링크 인덱스 일부를 확인하지 못했습니다. 연결·없음·유일성을 확정하지 않습니다.');}
 return response();
}
