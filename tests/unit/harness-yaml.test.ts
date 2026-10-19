import {expect,it} from 'vitest';
import {parseHarnessYaml,harnessFile} from '../../src/phase2/harness-yaml';
it('parses data aliases and markdown IDs',()=>{
 expect(parseHarnessYaml('a: &a [x]\nb: *a')).toEqual({a:['x'],b:['x']});
 expect(harnessFile('---\nid: MIG.DEV-1\n---\nBody','plan.md').data).toEqual({id:'MIG.DEV-1'});
});
it.each(['a: 1\na: 2','x: !exec nope','a: &a [*a]','x: ['+ '['.repeat(41) +'0'+']'.repeat(42),'x'.repeat(1024*1024+1)])('rejects unsafe or excessive YAML %#',text=>expect(()=>parseHarnessYaml(text)).toThrow());
