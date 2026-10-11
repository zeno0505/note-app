import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,realpath,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseWikiTarget,resolveWikiUri} from '../../src/main/projects/wikilinks';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe('explicit project wikilinks',()=>{
 it('opens a dated exact document and anchor without judging age or reading contents',async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'note-wiki-')));roots.push(root);const vault=path.join(root,'vault'),note=path.join(vault,'project');await mkdir(path.join(note,'design'),{recursive:true});await writeFile(path.join(note,'design','2020-01-01.md'),'synthetic only');
  expect(await resolveWikiUri({wikilink:'[[design/2020-01-01#합의|설계 합의]]',canonicalNotePath:note,vaultRootPath:vault})).toEqual({label:'설계 합의',uri:'obsidian://open?vault=vault&file=project%2Fdesign%2F2020-01-01%23%ED%95%A9%EC%9D%98'});
  const other=path.join(vault,'other.md');await writeFile(other,'synthetic other');await symlink(other,path.join(note,'escape.md'));await expect(resolveWikiUri({wikilink:'[[escape]]',canonicalNotePath:note,vaultRootPath:vault})).rejects.toThrow('등록 범위');
  await expect(resolveWikiUri({wikilink:'[[missing]]',canonicalNotePath:note,vaultRootPath:vault})).rejects.toThrow();
 });
 it.each(['file','[[../secret]]','[[/absolute]]','[[https://example.test]]','[[a\\b]]','[[a|b|c]]','[[a#]]','[[a\n]]'])('rejects unrestricted input %s',input=>expect(()=>parseWikiTarget(input)).toThrow());
});
