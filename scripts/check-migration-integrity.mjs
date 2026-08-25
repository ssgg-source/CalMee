#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = resolve(root, 'frontend/src-tauri/migrations');
const manifest = JSON.parse(readFileSync(resolve(migrations, 'checksums.json'), 'utf8'));
const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
const errors = [];

for (const name of files) {
  const expected = manifest[name];
  if (!expected) {
    errors.push(`${name}: missing from checksums.json`);
    continue;
  }
  const actual = createHash('sha384').update(readFileSync(resolve(migrations, name))).digest('hex');
  if (actual !== expected) errors.push(`${name}: immutable migration checksum changed`);
}
for (const name of Object.keys(manifest)) {
  if (!files.includes(name)) errors.push(`${name}: protected migration is missing`);
}

if (errors.length) {
  console.error('Migration integrity check failed:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`Migration integrity check passed (${files.length} immutable migrations).`);
