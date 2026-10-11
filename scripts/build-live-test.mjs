import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('dist/electron-tests',{recursive:true});
await build({entryPoints:['tests/electron/live-fixture/seed-summary.ts'],outfile:'dist/electron-tests/live-fixture-tools.mjs',platform:'node',format:'esm',bundle:true,target:'node24',sourcemap:true});
