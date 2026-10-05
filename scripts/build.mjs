import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await viteBuild();
await build({entryPoints:['src/main/index.ts'],outfile:'dist/main/index.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
await build({entryPoints:['src/preload/index.ts'],outfile:'dist/preload/index.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
