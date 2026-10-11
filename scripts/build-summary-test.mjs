import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/electron-tests',{recursive:true});
await build({entryPoints:['tests/electron/summary-fixture/main.ts'],outfile:'dist/electron-tests/summary-main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await copyFile('tests/electron/summary-fixture/preload.cjs','dist/electron-tests/summary-preload.cjs');
