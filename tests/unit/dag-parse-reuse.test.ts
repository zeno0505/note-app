import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueryProcess, QUERY_SHA256, type ProcessResult } from '../../src/facts/dag-read-model/process';

const pythonPath = process.env.DAG_QUERY_PYTHON;
const queryScriptPath = process.env.DAG_QUERY_SCRIPT;
const directories: string[] = [];
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

// Frozen pre-reuse semantic reference: the pinned original loader runs for each
// original main, the optional shape check, and phase extraction. This reference
// deliberately does not derive its behavior by rewriting the optimized code.
const ORIGINAL_REPARSE = String.raw`import sys, json, pathlib, hashlib
script, source, done, expected, require_shape = sys.argv[1:]
code = pathlib.Path(script).read_bytes()
assert hashlib.sha256(code).hexdigest() == expected
namespace = {'__name__': '__dag_query_transport__', '__file__': script}
exec(compile(code, script, 'exec'), namespace)
source = pathlib.Path(source)
if require_shape == '1':
    _, document, _ = namespace['load'](source)
    if not isinstance(document, dict) or not isinstance(document.get('phases'), list): sys.exit(65)
    if any(not isinstance(phase, dict) or not isinstance(phase.get('tasks'), list) for phase in document['phases']): sys.exit(65)
result = {}
for mode, args in [
    ('index', ['--index', '--fields', 'id,title,status,depends_on,e2e,commits']),
    ('coverage', ['--coverage', '--done-status', done]),
    ('details', ['--index', '--fields', 'id,type,feature,description,acceptance_criteria,target_files,discussion,design']),
    ('policies', ['--policy', '--all']),
]:
    emitted = []
    namespace['emit'] = emitted.append
    sys.argv = [script, str(source)] + args
    namespace['main']()
    assert len(emitted) == 1
    result[mode] = emitted[0]
_, document, _ = namespace['load'](source)
phases = document.get('phases')
if not isinstance(phases, list): raise RuntimeError('unsupported phase shape')
result['phases'] = []
for number, phase in enumerate(phases):
    if not isinstance(phase, dict) or not isinstance(phase.get('tasks'), list): raise RuntimeError('unsupported phase shape')
    result['phases'].append({'index': number, 'id': phase.get('id'), 'title': phase.get('title', phase.get('name')), 'taskIds': [task.get('id') for task in phase['tasks']]})
result['readContractVersion'] = 2
sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8') + bytes([10]))
`;

function runPython(code: string, args: string[]) {
  return new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(pythonPath!, ['-I', '-B', '-c', code, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (!('code' in error) || error.killed)) return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function fixture(body: string | Buffer) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dag-parse-reuse-test-')));
  directories.push(directory);
  const source = join(directory, 'source.yaml');
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  await writeFile(source, bytes);
  return { directory, source, bytes };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const cases: Array<{ name: string; body: string | Buffer; expected: 'ok' | 'command_failed' | 'shape' }> = [
  { name: 'empty phases', body: 'phases: []\n', expected: 'ok' },
  { name: 'rich declarations and Korean text', body: JSON.stringify({ phases: [{ id: 'P-1', name: '설계', tasks: [{ id: 'T-1', title: '근거', status: 'finished', depends_on: ['EXT-1'], commits: 'legacy', e2e: { required: true, covered_by: [] }, description: '설명', acceptance_criteria: ['확인'] }, { id: 'T-2', status: 'future', e2e: { required: true, covered_by: 'malformed' } }] }], project_policy: [{ key: 'branch', decision: 'main', legacy: true }] }), expected: 'ok' },
  { name: 'malformed YAML', body: 'phases: [broken', expected: 'command_failed' },
  { name: 'invalid UTF-8', body: Buffer.from([0xff, 0xfe]), expected: 'command_failed' },
  { name: 'empty document', body: '', expected: 'command_failed' },
  { name: 'null document', body: 'null\n', expected: 'command_failed' },
  { name: 'scalar document', body: '42\n', expected: 'command_failed' },
  { name: 'list document', body: '[]\n', expected: 'command_failed' },
  { name: 'missing phases', body: '{}\n', expected: 'shape' },
  { name: 'null phases', body: 'phases: null\n', expected: 'shape' },
  { name: 'empty mapping phases', body: 'phases: {}\n', expected: 'shape' },
  { name: 'scalar phases rejected by original loader', body: 'phases: 42\n', expected: 'command_failed' },
  { name: 'null phase rejected by original loader', body: 'phases: [null]\n', expected: 'command_failed' },
  { name: 'null tasks', body: 'phases: [{tasks: null}]\n', expected: 'shape' },
  { name: 'missing tasks', body: 'phases: [{}]\n', expected: 'shape' },
  { name: 'string tasks', body: 'phases: [{tasks: abc}]\n', expected: 'shape' },
  { name: 'null task', body: 'phases: [{tasks: [null]}]\n', expected: 'command_failed' },
  { name: 'scalar task', body: 'phases: [{tasks: [42]}]\n', expected: 'command_failed' },
  { name: 'shared aliases and merge keys', body: 'spec: &spec {required: true, covered_by: []}\nbase: &base {status: finished, e2e: *spec}\nphases:\n  - tasks:\n      - {<<: *base, id: T-1}\n      - {<<: *base, id: T-2}\n', expected: 'ok' },
  { name: 'ignored recursive aliases', body: 'metadata: &loop {self: *loop}\nphases:\n  - tasks:\n      - &task {id: T-1, metadata: *task}\n', expected: 'ok' },
  { name: 'exported recursive aliases', body: 'phases:\n  - tasks:\n      - id: T-1\n        description: &loop [*loop]\n', expected: 'command_failed' },
  { name: 'deep unused alias chain accepted by original parser', body: ['selected: null', 'a0: &a0 []', ...Array.from({ length: 649 }, (_, index) => `a${index + 1}: &a${index + 1} [*a${index}]`), 'selected: *a649', 'phases: [{tasks: []}]'].join('\n'), expected: 'ok' },
  { name: 'ignored YAML timestamps', body: 'created: 2026-10-08\nphases:\n  - tasks:\n      - {id: T-1, created: 2026-10-08T01:02:03Z}\n', expected: 'ok' },
  { name: 'exported YAML date', body: 'phases:\n  - tasks:\n      - {id: T-1, description: 2026-10-08}\n', expected: 'command_failed' },
  { name: 'exported YAML timestamp', body: 'phases:\n  - tasks:\n      - {id: T-1, description: 2026-10-08T01:02:03Z}\n', expected: 'command_failed' },
  { name: 'exported non-finite number', body: 'phases: [{tasks: [{id: T-1, description: .nan}]}]\n', expected: 'command_failed' },
  { name: 'duplicate keys retain original YAML behavior', body: 'phases: [{tasks: [{id: T-1, status: pending, status: finished}]}]\n', expected: 'ok' },
];

describe.skipIf(!pythonPath || !queryScriptPath)('single-parse transport against actual pinned query (opt-in private dependency)', () => {
  beforeAll(async () => { expect(digest(await readFile(queryScriptPath!))).toBe(QUERY_SHA256); });

  for (const requireDocumentShape of [false, true]) {
    describe(`required document shape: ${requireDocumentShape}`, () => {
      it.each(cases)('matches original repeated parsing: $name', async ({ body, expected }) => {
        const t = await fixture(body);
        const before = await stat(t.source);
        const reference = await runPython(ORIGINAL_REPARSE, [queryScriptPath!, t.source, 'finished', QUERY_SHA256, requireDocumentShape ? '1' : '0']);
        const baseline: ProcessResult = reference.code === 0
          ? { ok: true, data: JSON.parse(reference.stdout) }
          : { ok: false, kind: requireDocumentShape && reference.code === 65 ? 'document_shape_invalid' : 'command_failed' };
        const actual = await createQueryProcess({ pythonPath: pythonPath!, queryScriptPath: queryScriptPath!, doneStatus: 'finished', timeoutMs: 10000, maxOutputBytes: 1024 * 1024, requireDocumentShape })(t.source, digest(t.bytes), 1024 * 1024, new AbortController().signal);
        expect(actual).toEqual(baseline);
        expect(actual).toMatchObject(expected === 'ok' ? { ok: true } : { ok: false, kind: expected === 'shape' && requireDocumentShape ? 'document_shape_invalid' : 'command_failed' });
        expect(await readFile(t.source)).toEqual(t.bytes);
        expect((await stat(t.source)).mtimeMs).toBe(before.mtimeMs);
      }, 15000);
    });
  }

  it.each([false, true])('parses once and preserves isolated whole-tuple graphs (shape=%s)', async requireDocumentShape => {
    const t = await fixture('phases:\n  - tasks:\n      - &first\n        id: T-1\n        e2e: &spec {required: true, covered_by: []}\n        metadata: *first\n        created: 2026-10-08T01:02:03Z\n      - {id: T-2, e2e: *spec}\n');
    // Inspect the actual private transport literal without adding a production
    // export or allowing a replacement authoritative query implementation.
    const processSource = await readFile(new URL('../../src/facts/dag-read-model/process.ts', import.meta.url), 'utf8');
    const transport = processSource.match(/const TRANSPORT = `([\s\S]*?)`;/)?.[1];
    expect(transport).toBeDefined();
    const transportPath = join(t.directory, 'transport.py');
    await writeFile(transportPath, transport!);
    const probe = await runPython(String.raw`import sys, pathlib, io, json, datetime
transport_path, script, source, expected, source_hash, directory, shape = sys.argv[1:]
transport = pathlib.Path(transport_path).read_text(encoding='utf-8')
original_loads, copies, modes = [], [], []
def trace(frame, event, arg):
    if frame.f_code.co_filename == script:
        if frame.f_code.co_name == 'load' and event == 'return': original_loads.append(arg)
        if frame.f_code.co_name == 'main' and event == 'call': modes.append(sys.argv[2:])
    if frame.f_code.co_filename == transport_path and frame.f_code.co_name == 'load_snapshot' and event == 'return': copies.append(arg)
    return trace
sys.argv = [transport_path, script, source, 'finished', expected, source_hash, str(1024 * 1024), directory, shape]
output, errors = io.BytesIO(), io.StringIO()
saved_stdout, saved_stderr = sys.stdout, sys.stderr
sys.stdout, sys.stderr = io.TextIOWrapper(output, encoding='utf-8'), errors
scope = {'__name__': '__probe__'}
try:
    sys.settrace(trace)
    exec(compile(transport, transport_path, 'exec'), scope)
finally:
    sys.settrace(None)
    sys.stdout.flush()
    payload = output.getvalue()
    sys.stdout, sys.stderr = saved_stdout, saved_stderr
assert len(original_loads) == 1, len(original_loads)
assert len(copies) == (6 if shape == '1' else 5), len(copies)
original = original_loads[0]
for loaded in [original] + copies:
    raw, document, tasks = loaded
    assert raw == pathlib.Path(source).read_text(encoding='utf-8')
    assert tasks[0] is document['phases'][0]['tasks'][0]
    assert tasks[1] is document['phases'][0]['tasks'][1]
    assert tasks[0]['e2e'] is tasks[1]['e2e']
    assert tasks[0]['metadata'] is tasks[0]
    assert isinstance(tasks[0]['created'], datetime.datetime)
    assert tasks[0]['created'].tzinfo is not None
for index, loaded in enumerate(copies):
    _, document, tasks = loaded
    assert document is not original[1] and tasks is not original[2]
    assert tasks[0] is not original[2][0]
    for other in copies[index + 1:]:
        assert document is not other[1] and tasks is not other[2]
        assert tasks[0]['e2e'] is not other[2][0]['e2e']
copies[0][2][0]['e2e']['covered_by'].append('mutated')
copies[0][1]['phases'][0]['tasks'].append({'id': 'MUTATED'})
assert copies[0][2][1]['e2e']['covered_by'] == ['mutated']
for loaded in [original] + copies[1:]:
    assert loaded[2][0]['e2e']['covered_by'] == []
    assert len(loaded[1]['phases'][0]['tasks']) == 2
try:
    scope['load_snapshot'](pathlib.Path(source))
    raise AssertionError('unexpected non-snapshot path accepted')
except RuntimeError as error:
    assert str(error) == 'unsupported snapshot path'
print(json.dumps({'originalLoads': len(original_loads), 'copies': len(copies), 'modes': modes, 'result': json.loads(payload)}))
`, [transportPath, queryScriptPath!, t.source, QUERY_SHA256, digest(t.bytes), t.directory, requireDocumentShape ? '1' : '0']);
    expect(probe.stderr, probe.stderr).toBe('');
    expect(probe.code, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout);
    expect(result.originalLoads).toBe(1);
    expect(result.copies).toBe(requireDocumentShape ? 6 : 5);
    expect(result.modes).toEqual([
      ['--index', '--fields', 'id,title,status,depends_on,e2e,commits'],
      ['--coverage', '--done-status', 'finished'],
      ['--index', '--fields', 'id,type,feature,description,acceptance_criteria,target_files,discussion,design'],
      ['--policy', '--all'],
    ]);
    expect(result.result.coverage).toMatchObject({ tasks_total: 2, declared: 2, required: 2 });
  }, 15000);
});
