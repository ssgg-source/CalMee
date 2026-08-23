#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(projectRoot, 'funasr_sidecar', 'requirements.txt');
const lockRoot = resolve(projectRoot, 'funasr_sidecar', 'locks');
const targets = [
  ['darwin-arm64', 'aarch64-apple-darwin'],
  ['linux-x64', 'x86_64-manylinux_2_28'],
  ['win32-x64', 'x86_64-pc-windows-msvc'],
];

mkdirSync(lockRoot, { recursive: true });
for (const [key, platform] of targets) {
  const args = [
    'pip', 'compile', input,
    '--python-version', '3.11.15',
    '--python-platform', platform,
    '--generate-hashes',
    '--no-annotate',
    '--custom-compile-command', 'node scripts/lock-funasr-runtime.mjs',
    '--output-file', resolve(lockRoot, `${key}.lock`),
    '--quiet',
  ];
  const result = spawnSync('uv', args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Could not generate ${key}.lock`);
  }
}
