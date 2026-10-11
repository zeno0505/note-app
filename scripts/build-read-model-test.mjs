import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/electron-tests',{recursive:true});
await build({entryPoints:['tests/electron/read-model-fixture/main.ts'],outfile:'dist/electron-tests/read-model-main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await copyFile('tests/electron/read-model-fixture/preload.cjs','dist/electron-tests/read-model-preload.cjs');
