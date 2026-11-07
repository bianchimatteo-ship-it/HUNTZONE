import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const esbuild = resolve(root, 'node_modules/esbuild/bin/esbuild');
const result = spawnSync(esbuild, [
  'apps/api/src/server.ts',
  'apps/api/src/migrate.ts',
  '--bundle',
  '--packages=external',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  '--outdir=dist/api',
], { cwd: root, stdio: 'inherit' });

if (result.status !== 0) process.exit(result.status ?? 1);
const migrations = resolve(root, 'dist/migrations');
await mkdir(migrations, { recursive: true });
await cp(resolve(root, 'apps/api/migrations'), migrations, { recursive: true });
