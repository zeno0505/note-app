// TEST FIXTURE ONLY. Tests prepend a trusted Node shebang in a temporary directory.
const fs = require('node:fs');
const path = require('node:path');
const commands = {
  '["status","--json"]': 'status',
  '["project","list","--json"]': 'projects',
  '["worktree","list","--limit","1000","--json"]': 'worktrees',
  '["worktree","ps","--limit","1000","--json"]': 'processes',
};
const args = process.argv.slice(2);
const query = commands[JSON.stringify(args)];
if (!query) process.exit(90);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\n');
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
let mode = {};
try { mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8')); } catch {}
const selectedMode = !mode.query || mode.query === query ? mode.kind : undefined;
// Lifecycle regression modes spawn a same-group descendant that ignores SIGTERM.
// Its only local output is a synthetic PID/ready marker owned by this fixture.
if (typeof selectedMode === 'string' && selectedMode.startsWith('descendant-')) {
  const { spawn } = require('node:child_process');
  const inherited = selectedMode.includes('-inherited-');
  const child = spawn(process.execPath, ['-e',
    "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",
    path.join(__dirname, 'descendant-pid')], { stdio: inherited ? ['ignore', 1, 2] : 'ignore' });
  child.unref();
  const readyDeadline = Date.now() + 1500;
  const wait = setInterval(() => {
    if (!fs.existsSync(path.join(__dirname, 'descendant-pid'))) {
      if (Date.now() > readyDeadline) { clearInterval(wait); process.exitCode = 91; }
      return;
    }
    clearInterval(wait);
    if (selectedMode.endsWith('-hang')) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
    if (selectedMode.endsWith('-error')) { process.exitCode = 3; return; }
    if (selectedMode.endsWith('-invalid')) { process.stdout.write('{invalid'); return; }
    process.stdout.write(fs.readFileSync(path.join(__dirname, `${query}.json`)));
  }, 5);
} else if (selectedMode === 'hang' || selectedMode === 'ignore-term') {
  if (selectedMode === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (selectedMode === 'overflow' || selectedMode === 'stderr-overflow') {
  const stream = selectedMode === 'overflow' ? process.stdout : process.stderr;
  stream.write('SYNTHETIC_DISCARDED_OUTPUT'.repeat(10000));
  setInterval(() => {}, 1000);
} else if (selectedMode === 'nonzero') {
  process.stderr.write('SYNTHETIC_ERROR_BODY_MUST_NOT_ESCAPE');
  process.exitCode = 3;
} else if (selectedMode === 'invalid-json') {
  process.stdout.write('{invalid SYNTHETIC_ERROR_BODY_MUST_NOT_ESCAPE');
} else if (selectedMode === 'invalid-utf8') {
  process.stdout.write(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
} else {
  const value = JSON.parse(fs.readFileSync(path.join(__dirname, `${query}.json`), 'utf8'));
  const fixtureRoot = process.env.NOTE_APP_ORCA_FIXTURE_ROOT;
  if (fixtureRoot && (query === 'worktrees' || query === 'processes')) {
    for (const row of value.result.worktrees) {
      row.path = path.join(fixtureRoot, 'demo');
      if (query === 'worktrees') row.id = 'repo-synthetic::' + row.path;
      else row.worktreeId = 'repo-synthetic::' + row.path;
    }
  }
  if (selectedMode === 'denied') {
    process.stdout.write(JSON.stringify({id:'synthetic-denied',ok:false,error:{code:'runtime_access_denied',message:'SYNTHETIC_ERROR_BODY_MUST_NOT_ESCAPE',data:{nextSteps:['SYNTHETIC_ERROR_BODY_MUST_NOT_ESCAPE']}},_meta:{runtimeId:null}}));
    process.exitCode = 1;
  } else {
    if (selectedMode === 'runtime-change') value._meta.runtimeId = 'runtime-restarted';
    process.stdout.write(JSON.stringify(value));
  }
}
