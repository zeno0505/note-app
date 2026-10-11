import {build} from 'esbuild';
await build({entryPoints:['tests/electron/summary-review-fixture/production-main.ts'],outfile:'dist/main/summary-review-test.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24',sourcemap:true});
