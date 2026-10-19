/** Pure interpretation of a caller-authorized snapshot. No filesystem, network,
 * telemetry, script execution, or permission grant. The caller owns authorization. */
export interface HarnessFile { text: string; data?: unknown }
export type HarnessFiles = ReadonlyMap<string, HarnessFile>;
export interface HarnessLinkResult {
  result: 'resolved' | 'resolved(archived)' | 'missing' | 'ambiguous' | 'out-of-scope' | 'unsupported';
  target?: Record<string, string>;
  warnings?: string[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function relative(value: string): string | null {
  if (value.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(value)) return null;
  const parts: string[] = [];
  for (const part of value.normalize('NFC').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
const parent = (value: string) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
const at = (root: string, name: string) => root ? root+'/'+name : name;
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(object) : [];
export function resolveHarnessLink(files: HarnessFiles, from: string, link: string): HarnessLinkResult {
  const result = (state: HarnessLinkResult['result'], target?: Record<string,string>, warnings: string[] = []): HarnessLinkResult =>
    ({ result: state, ...(target ? { target } : {}), warnings });
  if (files.size > 10000 || link.length > 4096 || /[\u0000-\u001f\u007f]/u.test(link)) return result('unsupported');
  const index = new Map<string,HarnessFile>();
  for (const [name,file] of files) {
    const normalized = relative(name);
    if (normalized === null || normalized !== name.normalize('NFC') || index.has(normalized)) return result('unsupported');
    index.set(normalized,file);
  }
  const origin = relative(from); if (origin === null) return result('out-of-scope');
  function ledgerFor(file: string): string | null {
    let dir = parent(file);
    for (;;) {
      if (index.has(at(dir,'dag.yaml'))) return dir;
      if (!dir) return null;
      dir = parent(dir);
    }
  }
  const originLedger = ledgerFor(origin);
  function warn(file: string): string[] {
    const targetLedger = ledgerFor(file);
    return originLedger !== null && targetLedger !== null && originLedger !== targetLedger ? ['unpinned'] : [];
  }
  if (link.startsWith('https://')) {
    try {
      const url = new URL(link), parts = url.pathname.split('/').filter(Boolean);
      if (url.hostname !== 'github.com' || url.username || url.password || parts.length < 5 || parts[2] !== 'blob') return result('unsupported');
      const ref = decodeURIComponent(parts[3]);
      return result('resolved', {repo: parts[0]+'/'+parts[1], commit: ref, path: decodeURIComponent(parts.slice(4).join('/')), ...(url.hash ? {anchor: decodeURIComponent(url.hash.slice(1))} : {})}, /^[0-9a-f]{7,40}$/i.test(ref) ? [] : ['unpinned']);
    } catch { return result('unsupported'); }
  }
  if (!link.startsWith('[[') || !link.endsWith(']]')) return result('unsupported');
  let body: string;
  try { body = decodeURIComponent(link.slice(2,-2).replace(/\\\|/g,'|').split('|')[0]); }
  catch { return result('unsupported'); }
  if (!body || body.includes(':') || /[\u0000-\u001f\u007f]/u.test(body)) return result('unsupported');
  const hash = body.indexOf('#');
  const name = hash < 0 ? body : body.slice(0,hash), anchor = hash < 0 ? null : body.slice(hash+1);
  if (!name) return result('unsupported');
  if (name.startsWith('/')) return result('out-of-scope');
  const base = originLedger ?? parent(origin);
  const basename = name.slice(name.lastIndexOf('/')+1);
  if (['dag','dag.md','dag.yaml'].includes(basename)) {
    if (anchor !== null && (!anchor || /\s/u.test(anchor) || anchor.split('/').some(v=>!v) || anchor.split('/').length>2)) return result('unsupported');
    const dir = name.includes('/') ? relative(at(base,parent(name))) : originLedger;
    if (dir === null) return result(originLedger === null && !name.includes('/') ? 'missing' : 'out-of-scope');
    const file = at(dir,'dag.yaml'), declaration = index.get(file)?.data;
    if (!index.has(file)) return result('missing');
    const ledger = object(declaration) && typeof declaration.ledger_key === 'string' ? declaration.ledger_key : dir.split('/').at(-1) ?? '';
    if (anchor === null) return result('resolved',{ledger,file},warn(file));
    const [id,ac] = anchor.split('/');
    const tasks = object(declaration) ? rows(declaration.phases).flatMap(p=>rows(p.tasks)) : [];
    let matches = tasks.filter(t=>t.id===id), legacy = false;
    if (!matches.length) {
      const archived = rows(index.get(at(dir,'archive/index.yaml'))?.data).filter(t=>t.id===id);
      if (archived.length>1) return result('ambiguous');
      if (archived.length===1) {
        const target: Record<string,string>={ledger,task:id};
        for (const key of ['summary','inbox']) if (typeof archived[0][key]==='string') target[key]=archived[0][key] as string;
        if (ac) target.ac=ac;
        return result('resolved(archived)',target,[...warn(file),...(ac?['ac-unverified']:[])]);
      }
      matches = tasks.filter(t=>typeof t.legacy_ref==='string' && /(?:^|\/)dag(?:\.yaml|\.md)?@[0-9a-f]{7,40}#/i.test(t.legacy_ref) && t.legacy_ref.split('#').at(-1)===id);
      legacy=true;
    }
    if (matches.length>1) return result('ambiguous');
    if (!matches.length) return result('missing');
    if (ac && !rows(matches[0].acceptance).some(item=>item.id===ac)) return result('missing');
    return result('resolved',{ledger,task:String(matches[0].id),...(ac?{ac}:{}),...(legacy?{via:'legacy_ref'}:{})},warn(file));
  }
  if (name.includes('/') || name.startsWith('.')) {
    const path = relative(at(base,name)); if (path===null) return result('out-of-scope');
    const file = index.has(path) ? path : path+'.md';
    if (!index.has(file)) return result('missing');
    return result('resolved',{file,...(anchor?{anchor}:{})},warn(file));
  }
  const matches = [...index].filter(([file,value])=>file.endsWith('.md') && object(value.data) && value.data.id===name);
  if (matches.length>1) return result('ambiguous');
  if (!matches.length) return result('missing');
  return result('resolved',{file:matches[0][0],...(anchor?{anchor}:{})},warn(matches[0][0]));
}
