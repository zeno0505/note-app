import { describe, expect, it } from 'vitest';
import { parseOrcaResponse } from '../../src/collector/orca';
import { fixture } from '../../fixtures/orca/test-helpers';

describe('Orca allowlisted response projection', () => {
  it('accepts the observed project list without invented pagination requirements', async () => {
    const result = parseOrcaResponse('projects', JSON.stringify(await fixture('projects')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeId).toBe('runtime-synthetic');
    expect(result.value.data.coverage).toEqual({ state:'unknown', returnedCount:1, totalCount:null, truncated:null, hostIds:null, omittedHostIds:null });
    expect(result.value.data.records[0].id).toBe('github:example/demo');
  });
  it('strips adversarial extra fields at every projected nesting level', async () => {
    const value = await fixture('processes');
    const forbidden = {prompt:'SYNTHETIC_PRIVATE_CANARY',preview:'SYNTHETIC_PRIVATE_CANARY',lastAssistantMessage:'SYNTHETIC_PRIVATE_CANARY',toolInput:{body:'SYNTHETIC_PRIVATE_CANARY'},toolName:'SYNTHETIC_PRIVATE_CANARY'};
    Object.assign(value, forbidden); Object.assign(value._meta, forbidden); Object.assign(value.result, forbidden);
    Object.assign(value.result.hostScope, forbidden); Object.assign(value.result.worktrees[0], forbidden); Object.assign(value.result.worktrees[0].agents[0], forbidden);
    const result = parseOrcaResponse('processes', JSON.stringify(value));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CANARY');
    for (const key of Object.keys(forbidden)) expect(JSON.stringify(result)).not.toContain(`"${key}"`);
  });
  it('does not turn terminal connectivity or future agent states into working/done/DAG state', async () => {
    const value = await fixture('processes');
    value.result.worktrees[0].agents[0].state = 'working';
    value.result.worktrees[0].status = 'future-status';
    const result = parseOrcaResponse('processes', JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.records[0]).toMatchObject({isActive:true,liveTerminalCount:1,hasAttachedPty:true,activityStatus:'unknown',lastOutputAt:1700000001000,agents:[{state:'unknown'}]});
    expect(JSON.stringify(result)).not.toContain('dagState');
  });
  it('preserves separate observed done, terminal, and activity dimensions', async () => {
    const result = parseOrcaResponse('processes', JSON.stringify(await fixture('processes')));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.records[0]).toMatchObject({isActive:true,hasAttachedPty:true,agents:[{state:'done'}]});
  });
  it.each([undefined, null])('permits missing/null project mapping without inventing a repo match (%s)', async missing => {
    const value = await fixture('worktrees'); value.result.worktrees[0].projectId = missing;
    const result = parseOrcaResponse('worktrees', JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.records[0].projectId).toBeNull();
  });
  it.each(['', null, undefined])('projects an empty/missing branch as no branch (%s)', async branch => {
    const value = await fixture('worktrees');
    Object.assign(value.result.worktrees[0], { branch, projectId: null });
    const result = parseOrcaResponse('worktrees', JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.records[0]).toMatchObject({ branch: null, projectId: null });
  });
  it('retains a bounded named branch unchanged', async () => {
    const value = await fixture('worktrees'); value.result.worktrees[0].branch = 'feature/synthetic';
    const result = parseOrcaResponse('worktrees', JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.records[0].branch).toBe('feature/synthetic');
  });
  it.each([42, false, {}, [], 'x'.repeat(4097), 'bad\nbranch', 'bad\u0000branch', 'bad\u007fbranch'])('rejects malformed optional branch (%#)', async branch => {
    const value = await fixture('worktrees'); value.result.worktrees[0].branch = branch;
    expect(parseOrcaResponse('worktrees', JSON.stringify(value))).toMatchObject({ ok: false, error: { kind: 'invalid_schema' } });
  });
  it.each(['id', 'repoId', 'projectId', 'hostId', 'instanceId', 'path'])('does not relax empty %s validation for the branch exception', async field => {
    const value = await fixture('worktrees'); value.result.worktrees[0][field] = '';
    expect(parseOrcaResponse('worktrees', JSON.stringify(value))).toMatchObject({ ok: false, error: { kind: 'invalid_schema' } });
  });
  it('keeps truncated, omitted hosts, unknown counts, and normal complete empty distinct', async () => {
    const value = await fixture('worktrees');
    value.result.truncated = true; value.result.hostScope.omittedHostIds = ['unobserved-host']; delete value.result.totalCount;
    const partial = parseOrcaResponse('worktrees', JSON.stringify(value));
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.value.data.coverage).toMatchObject({state:'partial',returnedCount:1,totalCount:null,truncated:true,omittedHostIds:['unobserved-host']});
    value.result.worktrees = []; value.result.totalCount = 0; value.result.truncated = false; value.result.hostScope.omittedHostIds = [];
    const empty = parseOrcaResponse('worktrees', JSON.stringify(value));
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.data.coverage).toMatchObject({state:'complete',returnedCount:0,totalCount:0});
  });
  it('treats absent optional observation metadata as unknown', async () => {
    const value = await fixture('worktrees');
    value.result.worktrees = [{id:'synthetic-id'}];
    delete value.result.hostScope; delete value.result.totalCount; delete value.result.truncated; delete value._meta;
    const result = parseOrcaResponse('worktrees', JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.runtimeId).toBeNull();
      expect(result.value.data.records[0].identity).toEqual({hostId:null,instanceId:null,sourceKey:null});
      expect(result.value.data.coverage.state).toBe('unknown');
    }
  });
  it.each([
    (v: any) => { v.result.worktrees = {}; },
    (v: any) => { v.result.worktrees[0].isArchived = 'false'; },
    (v: any) => { v.result.worktrees[0].identity.executionHostId = 'other'; },
    (v: any) => { v.result.hostScope.hostIds = ['other']; },
    (v: any) => { v.result.hostScope.omittedHostIds = ['local']; },
    (v: any) => { v.result.totalCount = 0; },
    (v: any) => { v.result.totalCount = 1.2; },
    (v: any) => { v.result.truncated = 'false'; },
    (v: any) => { v.result.worktrees[0].id = ''; },
    (v: any) => { v.result.worktrees[0].path = 'x'.repeat(4097); },
    (v: any) => { v.result.worktrees = Array(1001).fill(v.result.worktrees[0]); },
  ])('rejects known-field schema inconsistency safely (%#)', async mutate => {
    const value = await fixture('worktrees'); mutate(value);
    expect(parseOrcaResponse('worktrees', JSON.stringify(value))).toMatchObject({ok:false,error:{kind:'invalid_schema'}});
  });
  it.each(['', '{', 'null', '[]', '{}', '{"ok":"true","result":{}}'])('does not turn invalid response %s into success', value => {
    expect(parseOrcaResponse('projects', value).ok).toBe(false);
  });
  it('returns safe errors without remote diagnostic data', () => {
    const result = parseOrcaResponse('projects', JSON.stringify({ok:false,error:{code:'runtime_access_denied',message:'SYNTHETIC_PRIVATE_CANARY',data:{nextSteps:['SYNTHETIC_PRIVATE_CANARY']}},_meta:{runtimeId:null}}));
    expect(result).toMatchObject({ok:false,error:{kind:'access_denied',runtimeId:null}});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CANARY');
  });
  it('maps unsupported remote errors and runtime state safely', async () => {
    expect(parseOrcaResponse('status', '{"ok":false,"error":{"code":"unrecognized-private-text","message":"private"}}')).toMatchObject({ok:false,error:{kind:'remote_error'}});
    const value = await fixture('status'); value.result.runtime.state = 'future-private-state';
    const result = parseOrcaResponse('status', JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.runtimeState).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('future-private-state');
  });
  it('rejects contradictory runtime IDs and oversized direct parser calls', async () => {
    const value = await fixture('status'); value.result.runtime.runtimeId = 'other-runtime';
    expect(parseOrcaResponse('status', JSON.stringify(value))).toMatchObject({ok:false,error:{kind:'invalid_schema'}});
    expect(parseOrcaResponse('status', ' '.repeat(8 * 1024 * 1024 + 1))).toMatchObject({ok:false,error:{kind:'output_limit'}});
  });
});
