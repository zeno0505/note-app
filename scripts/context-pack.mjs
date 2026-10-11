// Node 24 type stripping. No path arguments, DAG query, shell, inbox or file traversal.
import { buildContextPack, serializeContextPack } from '../src/summary/context/index.ts';
const INPUT_LIMIT = 1024 * 1024;
try {
  if (process.argv.length !== 2) throw new Error('No arguments accepted; pass extracted JSON on stdin');
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > INPUT_LIMIT) throw new Error('Input exceeds 1 MiB');
    chunks.push(chunk);
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  process.stdout.write(serializeContextPack(buildContextPack(JSON.parse(input))));
} catch {
  // Do not echo input text or parser excerpts into logs.
  process.stderr.write('Context pack rejected: invalid input, unsupported arguments, or insufficient budget\n');
  process.exitCode = 1;
}
