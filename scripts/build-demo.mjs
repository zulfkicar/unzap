import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'public/demo'), { recursive: true });
await build({
  entryPoints: [resolve(root, 'public/demo/engine-entry.js')],
  outfile: resolve(root, 'public/demo/engine.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  alias: { 'node:crypto': resolve(root, 'scripts/browser-crypto.js') },
  inject: [resolve(root, 'scripts/browser-buffer.js')],
  legalComments: 'eof',
});
const dest = process.argv[2];
if (dest) {
  const target = resolve(dest);
  await mkdir(target, { recursive: true });
  for (const file of ['index.html','demo.css','demo.js','worker.js','engine.js','sample.json'])
    await copyFile(resolve(root, 'public/demo', file), resolve(target, file));
}
console.log('Built the browser demo from the production importer, compiler and request adapters.');
const sources = ['src/migration.js','src/importer.js','src/import-adapters.js','src/graph-compiler.js','src/runtime.js','src/connectors.js','src/runner.js','src/store.js','src/oauth.js','src/oauth-store.js','src/agent-api.js','test/branch-adapters.test.js','test/restart-adapters.test.js','test/oauth.test.js','test/browser-demo.test.js'];
for (const directory of [resolve(root,'public/demo/source'), ...(dest?[resolve(dest,'source')]:[])]) {
  await mkdir(directory,{recursive:true});
  for (const source of sources) await copyFile(resolve(root,source),resolve(directory,source.replaceAll('/','-')+'.txt'));
}
