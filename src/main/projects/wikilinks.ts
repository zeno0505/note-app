import path from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
export interface WikiTarget {relativePath:string;anchor:string|null;label:string}
/** Only an explicit relative wikilink; no basename search, URL, directory scan or age rule. */
export function parseWikiTarget(input:string):WikiTarget {
 if(typeof input!=='string'||input.length>512||!input.startsWith('[[')||!input.endsWith(']]')||/[\u0000-\u001f\u007f]/u.test(input))throw new Error('명시된 문서 연결을 확인해 주세요.');
 const body=input.slice(2,-2),parts=body.split('|');if(parts.length>2||parts.some(p=>!p)||/[\[\]\\]/u.test(body))throw new Error('문서 연결 형식 오류');
 const target=parts[0].split('#');if(target.length>2||target.some(p=>!p))throw new Error('문서 연결 형식 오류');
 let relativePath=target[0];if(path.isAbsolute(relativePath)||relativePath.includes(':')||relativePath.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('허용되지 않은 문서 경로');
 if(!relativePath.endsWith('.md'))relativePath+='.md';
 return {relativePath,anchor:target[1]??null,label:parts[1]??target[0]};
}
function inside(root:string,candidate:string):boolean {const r=path.relative(root,candidate);return !!r&&r!=='..'&&!r.startsWith('../')&&!path.isAbsolute(r);}
export async function resolveWikiUri(input:{wikilink:string;canonicalNotePath:string;vaultRootPath:string}):Promise<{uri:string;label:string}> {
 const target=parseWikiTarget(input.wikilink),vault=await realpath(input.vaultRootPath),note=await realpath(input.canonicalNotePath);
 if(note!==input.canonicalNotePath||!inside(vault,note))throw new Error('노트 연결 범위가 변경되었습니다.');
 const filename=path.join(note,target.relativePath),canonical=await realpath(filename);
 if(!inside(note,canonical)||!inside(vault,canonical))throw new Error('문서가 등록 범위를 벗어났습니다.');
 const stat=await lstat(canonical);if(!stat.isFile()||stat.size>4*1024*1024)throw new Error('문서 파일을 열 수 없습니다.');
 const file=path.relative(vault,canonical).replace(/\.md$/,'')+(target.anchor?'#'+target.anchor:'');
 return {uri:`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=${encodeURIComponent(file)}`,label:target.label};
}
