import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.vercel', 'output');
const functionDir = join(output, 'functions', 'api', 'server.func');

rmSync(output, { recursive: true, force: true });
mkdirSync(functionDir, { recursive: true });
cpSync(join(root, 'client', 'dist'), join(output, 'static'), { recursive: true });
cpSync(join(root, 'server', 'src', 'balance.json'), join(functionDir, 'balance.json'));

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'api', 'server.js')],
  outfile: join(functionDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['ws', 'bufferutil', 'utf-8-validate'],
  footer: { js: 'if (module.exports.default) module.exports = module.exports.default;' },
});
cpSync(join(root, 'node_modules', 'ws'), join(functionDir, 'node_modules', 'ws'), { recursive: true });
writeFileSync(join(functionDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
writeFileSync(join(functionDir, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.js',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  maxDuration: 300,
}, null, 2));
writeFileSync(join(output, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}, null, 2));

console.log('Wrote Vercel build output');
