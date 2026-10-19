import {expect,it} from 'vitest';
import {createSSRApp,h} from 'vue';
import {renderToString} from '@vue/server-renderer';
import HarnessTaskDeclaration from '../../src/renderer/components/HarnessTaskDeclaration.vue';
import SafeMarkdown from '../../src/renderer/components/SafeMarkdown.vue';
import {projectHarnessDeclarations,type HarnessTaskDeclaration as Declaration} from '../../src/phase2/harness-ledger';
import {extractDocumentReferences} from '../../src/phase2/markdown';
it('renders AC IDs, blockers, exceptions, decision and raw check provenance without claiming execution',async()=>{
 const tasks=[{id:'MIG.DEV-0001',harness:undefined as Declaration|undefined}];
 const ledger=projectHarnessDeclarations({ledger:{schema:3,profile:'v3',features:['future'],ledger_key:'MIG.DEV'},ledgerTasks:[{id:tasks[0].id,who:'zeno',question:'which?',judgment:{verdict:'met'},acceptance:[{id:'AC-1',expect:'<script>no</script>',verify_by:[{repo:'a',path:'test.py'},{check:{repo:'b',path:'test.py',made_by:'agent'}}],block:{reason:'needs_input'},exception:{reason_ref:'original'}}],verification:[{kind:'fixed',verdict:'unobserved',grade:'실행 관측',observes:['AC-1'],env:{target:{repo:'app'},via:{runner:'r'}}}]}]},tasks);
 const html=await renderToString(createSSRApp({render:()=>h(HarnessTaskDeclaration,{ledger,declaration:tasks[0].harness})}));
 for(const text of ['MIG.DEV','AC-1','검사 결과 연결 미확인','met은 장부의 선언','기능 미지원','future','which?','made_by','agent','needs_input','original','unobserved','observes','env.target / env.via'])expect(html).toContain(text);
 expect(html).not.toContain('<script>no</script>');expect(html).toContain('&lt;script&gt;no&lt;/script&gt;');
});
it.each(['"3"','99'])('visibly rejects unsupported schema %s',async schema=>{
 const ledger=projectHarnessDeclarations({ledger:{schema:JSON.parse(schema)},ledgerTasks:[]},[]);
 expect(await renderToString(createSSRApp({render:()=>h(HarnessTaskDeclaration,{ledger})}))).toContain('형식 미지원');
});
it('collects contract declarations separately from actual navigation, without parsing code as links',async()=>{
 const text='[fixed](https://github.com/o/r/blob/abcdef1/a.md) [[inbox/a%20b]] [[/etc/hosts]] `[[hidden]]`';
 expect(extractDocumentReferences(text).targets).toEqual([]);
 const refs=extractDocumentReferences(text,{harnessReferences:true});expect(refs.targets.map(t=>t.href)).toEqual(['https://github.com/o/r/blob/abcdef1/a.md','[[inbox/a%20b]]','[[/etc/hosts]]']);
 const html=await renderToString(createSSRApp({render:()=>h(SafeMarkdown,{text,harnessReferences:true})}));
 expect(html).toContain('네트워크 요청 없음');expect(html).not.toContain('<a ');expect(html).not.toContain('<iframe');
});
