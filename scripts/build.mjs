import {cp,mkdir} from 'node:fs/promises';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await viteBuild();
await build({entryPoints:['src/main/index.ts'],outfile:'dist/main/index.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await build({entryPoints:['src/preload/index.ts'],outfile:'dist/preload/index.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});

// The external updater stays outside the replaced process while installing.
await mkdir('dist/updater',{recursive:true});
await cp('scripts/update-installer.mjs','dist/updater/update-installer.mjs');
await cp('scripts/updater','dist/updater/updater',{recursive:true});
