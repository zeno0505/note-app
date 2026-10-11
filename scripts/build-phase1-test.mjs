import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('dist/main',{recursive:true});
await build({entryPoints:['tests/electron/phase1-fixture/main.ts'],outfile:'dist/main/phase1-test.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
