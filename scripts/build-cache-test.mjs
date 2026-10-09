import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/electron-tests',{recursive:true});
await build({entryPoints:['tests/electron/cache-fixture/main.ts'],outfile:'dist/electron-tests/cache-main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await copyFile('tests/electron/cache-fixture/preload.cjs','dist/electron-tests/cache-preload.cjs');
