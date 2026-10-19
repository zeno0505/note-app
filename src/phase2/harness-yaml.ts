import {parseDocument} from 'yaml';

/** Data-only YAML. Bounded input, aliases and nesting; no custom constructors. */
export function parseHarnessYaml(text:string):unknown {
  if(new TextEncoder().encode(text).length>1024*1024)throw Error('YAML byte limit');
  const doc=parseDocument(text,{schema:'core',strict:true,uniqueKeys:true});
  if(doc.errors.length||doc.warnings.length)throw Error('Unsupported YAML');
  const value:unknown=doc.toJS({maxAliasCount:50});
  let nodes=0;
  function check(item:unknown,depth:number,ancestors:Set<object>):void {
    if(++nodes>50000||depth>40)throw Error('YAML structure limit');
    if(item&&typeof item==='object'){
      if(ancestors.has(item))throw Error('Cyclic YAML');
      ancestors.add(item);
      for(const child of Object.values(item))check(child,depth+1,ancestors);
      ancestors.delete(item);
    }
  }
  check(value,0,new Set());return value;
}
export function harnessFile(text:string,name:string):{text:string;data?:unknown} {
  if(/\.ya?ml$/u.test(name))return {text,data:parseHarnessYaml(text)};
  if(/\.md$/u.test(name)&&text.startsWith('---\n')){
    const end=text.indexOf('\n---',4);
    if(end>=0&&/^\n---(?:\r?\n|$)/u.test(text.slice(end)))return {text,data:parseHarnessYaml(text.slice(4,end))};
  }
  return {text};
}
