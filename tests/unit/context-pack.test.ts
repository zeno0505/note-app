import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { buildContextPack, computeContextPackHash, CONTEXT_SCHEMA_HASH, parseContextInput, serializeContextPack, utf8Bytes, validateMissingContextRequest, type ContextInput, type ContextRecord } from '../../src/summary/context';
const hash = (n: string) => `sha256:${n.repeat(64)}`;
const record = (sourceId: string, text = 'Synthetic task declaration'): ContextRecord => ({ sourceId, sourceHash: hash('a'), observedAt: '2026-10-02T00:00:00.000Z', text, declaredStatus: 'pending', dependencies: [] });
const input = (): ContextInput => ({ schemaVersion: 1, scopeId: 'synthetic-workstream', records: [record('task-a'), record('task-b')], coverage: { complete: true, totalCount: 2, unknowns: [] }, previousSources: [], priorApprovedSummary: null, limits: { maxBytes: 16384, maxApproxTokens: 16384, maxRecords: 16 } });

describe('bounded deterministic extracted-record context packs', () => {
  it('is invariant to input order and detached from input; measures exact serialized bytes', () => {
    const a = input();
    const b = input(); b.records.reverse();
    const pack = buildContextPack(a);
    expect(serializeContextPack(pack)).toBe(serializeContextPack(buildContextPack(b)));
    a.records[0].text = 'changed outside';
    expect(pack.records[0].text).toBe('Synthetic task declaration');
    expect(pack.usage.bytes).toBe(utf8Bytes(serializeContextPack(pack)));
    expect(pack.usage.approximateTokens).toBe(pack.usage.bytes);
    expect(pack.schemaHash).toBe(CONTEXT_SCHEMA_HASH);
    expect(pack.packHash).toBe(computeContextPackHash(pack));
    const previousHash = pack.packHash; pack.records[0].text = 'tampered';
    expect(computeContextPackHash(pack)).not.toBe(previousHash);
  });
  it('prioritizes changed source over unchanged running source, keeping source deltas', () => {
    const v = input(); v.previousSources = v.records.map(r => ({sourceId: r.sourceId, sourceHash: r.sourceHash}));
    v.records[0].declaredStatus = 'running'; v.records[1].sourceHash = hash('b'); v.limits.maxRecords = 1;
    const pack = buildContextPack(v);
    expect(pack.records.map(r => r.sourceId)).toEqual(['task-b']);
    expect(pack.sources.map(s => s.change)).toEqual(['unchanged', 'changed']);
    expect(pack.exclusions).toEqual([{sourceId: 'task-a', reason: 'record-limit'}]);
    expect(pack.truncated).toBe(true);
  });
  it('omits whole records and conservatively budgets Unicode bytes', () => {
    const v = input(); v.records[0].text = '한'.repeat(2000); v.limits.maxBytes = 2300; v.limits.maxApproxTokens = 2200;
    const pack = buildContextPack(v);
    expect(pack.records.map(r => r.sourceId)).toEqual(['task-b']);
    expect(pack.usage.bytes).toBeLessThanOrEqual(2200);
    expect(pack.exclusions).toEqual([{sourceId:'task-a', reason:'budget'}]);
    expect(pack.sources).toHaveLength(2);
    expect(() => buildContextPack({...v, limits:{...v.limits, maxBytes:512}})).toThrow(/metadata/);
  });
  it('preserves dependencies, unknowns and absence without inferring readiness or tests', () => {
    const v = input(); v.coverage = {complete:false, totalCount:null, unknowns:['One bounded source unavailable']};
    v.records[0].dependencies = [{sourceId:'missing-task', declaredStatus:'unknown'}];
    v.previousSources = [{sourceId:'old-task', sourceHash:hash('c')}];
    const pack = buildContextPack(v);
    expect(pack.unresolvedDependencyIds).toEqual(['missing-task']);
    expect(pack.absentPreviousSources[0].state).toBe('not-observed');
    expect(pack.coverage.totalCount).toBeNull();
    expect(pack.records[0]).not.toHaveProperty('tested');
    v.coverage = {complete:true,totalCount:2,unknowns:[]};
    expect(buildContextPack(v).absentPreviousSources[0].state).toBe('removed');
  });
  it('retains only explicitly approved prior summaries with exact provenance and marks changed evidence stale', () => {
    const v = input(); v.previousSources = [{sourceId:'task-a',sourceHash:hash('b')}];
    v.priorApprovedSummary = {text:'Previously approved synthetic summary',approvedAt:'2026-10-02T01:00:00.000Z',approvalId:'decision-1',sources:v.previousSources};
    expect(buildContextPack(v).priorApprovedSummary?.freshness).toBe('stale');
    v.priorApprovedSummary.sources = [{sourceId:'task-a',sourceHash:hash('a')}];
    expect(buildContextPack(v).priorApprovedSummary?.freshness).toBe('current');
    v.priorApprovedSummary.sources[0].sourceHash = hash('d');
    expect(() => buildContextPack(v)).toThrow(/provenance/);
  });
  it('rejects unknown fields, paths, duplicate IDs, invalid time/hash, oversized arrays and false zero', () => {
    const invalid = [
      {...input(), path:'/private/data'},
      {...input(), scopeId:'../../inbox'},
      {...input(), records:[record('a'),record('a')]},
      {...input(), records:[{...record('a'),sourceHash:'fake'}]},
      {...input(), records:[{...record('a'),observedAt:'2026-02-30T00:00:00.000Z'}]},
      {...input(), records:Array.from({length:257},(_,i)=>record(`a-${i}`))},
      {...input(), coverage:{complete:false,totalCount:0,unknowns:[]}},
      {...input(), coverage:{complete:true,totalCount:null,unknowns:[]}},
      {...input(), limits:{maxBytes:Infinity,maxApproxTokens:1000,maxRecords:1}},
    ];
    for (const value of invalid) expect(() => parseContextInput(value)).toThrow();
  });
  it('rejects contradictory dependency declarations even if one record would be excluded', () => {
    const v = input();
    v.records[0].dependencies = [{sourceId:'task-b', declaredStatus:'done'}];
    v.limits.maxRecords = 1;
    expect(() => buildContextPack(v)).toThrow(/Contradictory/);
  });
  it('binds extraction changes even when upstream source hash is unchanged', () => {
    const v = input();
    v.previousSources = v.records.map(r => ({sourceId:r.sourceId,sourceHash:r.sourceHash}));
    const first = buildContextPack(v);
    v.records[0].text = 'Different extraction from same upstream source bytes';
    const second = buildContextPack(v);
    expect(second.sources.every(r => r.change === 'unchanged')).toBe(true);
    expect(second.packHash).not.toBe(first.packHash);
  });
  it('accepts bounded requests only for omitted IDs or unresolved dependency IDs', () => {
    const v = input(); v.limits.maxRecords = 1;
    const pack = buildContextPack(v);
    const request = {schemaVersion:1,scopeId:v.scopeId,sourceIds:['task-b'],reason:'Need missing task declaration',maxBytes:1000,maxApproxTokens:1000};
    expect(validateMissingContextRequest(request,pack).sourceIds).toEqual(['task-b']);
    for (const change of [{sourceIds:['task-a']},{sourceIds:['inbox']},{sourceIds:['../secret']},{maxBytes:16385},{scopeId:'other'},{command:'cat'}]) expect(() => validateMissingContextRequest({...request,...change},pack)).toThrow();
  });
  it('script accepts stdin only and produces no partial output on malformed/oversized input', () => {
    const run = (body: string, args: string[] = []) => spawnSync(process.execPath,['scripts/context-pack.mjs',...args],{input:body,encoding:'utf8'});
    const result = run(JSON.stringify(input()));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(buildContextPack(input()));
    for (const result of [run('{"private":"sensitive"'),run(' '.repeat(1024*1024+1)),run(JSON.stringify(input()),['/private/data'])]) {
      expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('sensitive');
    }
  });
});
