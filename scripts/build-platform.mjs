import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['server/platform/index.ts'],
  outfile: 'dist/server/platform.js',
  bundle: true,
  platform: 'node',
  target: 'node22.12',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

await mkdir('dist/server', { recursive: true });
await copyFile('server/platform/preview-supervisor.mjs', 'dist/server/preview-supervisor.mjs');

await build({
  entryPoints: ['server/platform/db-worker.ts'],
  outfile: 'dist/server/platform/db-worker.js',
  bundle: true,
  platform: 'node',
  target: 'node22.12',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: ['server/platform/cli.ts'],
  outfile: 'dist/server/platform-cli.js',
  bundle: true,
  platform: 'node',
  target: 'node22.12',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
