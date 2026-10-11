import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/electron-tests',{recursive:true});
await build({entryPoints:['tests/electron/collector-fixture/main.ts'],outfile:'dist/electron-tests/collector-main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await copyFile('tests/electron/collector-fixture/preload.cjs','dist/electron-tests/preload.cjs');
await build({entryPoints:['tests/electron/polling-fixture/main.ts'],outfile:'dist/electron-tests/polling-main.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await copyFile('tests/electron/polling-fixture/preload.cjs','dist/electron-tests/polling-preload.cjs');
