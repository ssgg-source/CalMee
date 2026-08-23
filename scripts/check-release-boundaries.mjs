#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenGit = [
  /^funasr-runtime\/(?!\.gitkeep$)/,
  /^frontend\/src-tauri\/binaries(?:\/|$)/,
  /(?:^|\/)target(?:\/|$)/,
  /\.app(?:\/|$)/,
];
const binaryModelExtensions = new Set(['.gguf', '.onnx', '.safetensors', '.ckpt', '.pt', '.bin']);

function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function lines(output) {
  return output.split('\n').map(value => value.trim()).filter(Boolean);
}

const errors = [];
const requirements = readFileSync(resolve(projectRoot, 'funasr_sidecar/requirements.txt'), 'utf8')
  .split('\n').map(value => value.trim()).filter(value => value && !value.startsWith('#'));
for (const requirement of requirements) {
  if (!/^[A-Za-z0-9_.-]+==[^<>=~!\s]+$/.test(requirement)) {
    errors.push('funasr_sidecar/requirements.txt: every direct dependency must use an exact == pin');
  }
}
for (const lockName of ['darwin-arm64.lock', 'linux-x64.lock', 'win32-x64.lock']) {
  const path = `funasr_sidecar/locks/${lockName}`;
  const content = readFileSync(resolve(projectRoot, path), 'utf8');
  for (const requirement of requirements) {
    if (!content.split('\n').some(line => line.startsWith(`${requirement} `) || line === requirement)) {
      errors.push(`${path}: missing direct pin ${requirement.split('==')[0]}`);
    }
  }
  const blocks = content.split(/\n(?=[A-Za-z0-9][A-Za-z0-9_.-]*==)/).filter(block => /^[A-Za-z0-9][A-Za-z0-9_.-]*==/.test(block));
  if (!blocks.length || blocks.some(block => !block.includes('--hash=sha256:'))) {
    errors.push(`${path}: every locked distribution must include at least one SHA-256 hash`);
  }
}
const tauriConfig = readFileSync(resolve(projectRoot, 'frontend/src-tauri/tauri.conf.json'), 'utf8');
if (tauriConfig.includes('funasr-runtime') || tauriConfig.includes('prepare-funasr-runtime')) {
  errors.push('frontend/src-tauri/tauri.conf.json: release packages must not contain or prepare a FunASR runtime');
}
const staged = lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
for (const path of staged) {
  if (forbiddenGit.some(pattern => pattern.test(path))) errors.push(`${path}: forbidden generated/runtime path is staged`);
  const absolute = resolve(projectRoot, path);
  try {
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) errors.push(`${path}: symbolic links are not allowed in the release source set`);
    if (metadata.isFile() && metadata.size > 5 * 1024 * 1024) errors.push(`${path}: staged file exceeds 5 MiB`);
    if (binaryModelExtensions.has(extname(path).toLowerCase())) errors.push(`${path}: possible model/binary asset is staged`);
  } catch {
    // Deleted files are excluded above; a concurrent change will be caught by Git.
  }
}

for (const expected of [
  'funasr-runtime/runtime.json',
  'funasr-runtime/python/runtime-placeholder',
  'frontend/src-tauri/binaries',
  'target/release/bundle/macos/CalMee.app',
]) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', expected], { cwd: projectRoot });
  } catch {
    errors.push(`${expected}: expected local build/runtime path is not ignored`);
  }
}

const candidates = git(['ls-files', '--modified', '--others', '--exclude-standard', '-z'])
  .split('\0').filter(Boolean);
const sensitivePatterns = [
  ['developer-home absolute path', /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-shaped token', /(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/],
];
const privateDataExtensions = new Set(['.sqlite', '.sqlite3', '.db', '.wav', '.mp3', '.m4a', '.mp4']);
for (const path of candidates) {
  const absolute = resolve(projectRoot, path);
  let metadata;
  try { metadata = lstatSync(absolute); } catch { continue; }
  if (metadata.isSymbolicLink()) {
    errors.push(`${path}: candidate symbolic link`);
    continue;
  }
  if (!metadata.isFile()) continue;
  if (metadata.size > 5 * 1024 * 1024) errors.push(`${path}: candidate file exceeds 5 MiB`);
  if (privateDataExtensions.has(extname(path).toLowerCase())) errors.push(`${path}: possible user/media/database data`);
  if (binaryModelExtensions.has(extname(path).toLowerCase())) errors.push(`${path}: possible model/binary asset`);
  if (metadata.size <= 5 * 1024 * 1024) {
    const content = readFileSync(absolute, 'utf8');
    for (const [category, pattern] of sensitivePatterns) {
      if (pattern.test(content)) errors.push(`${path}: ${category}`);
    }
  }
}

const appArgIndex = process.argv.indexOf('--app');
if (appArgIndex !== -1) {
  const appRoot = resolve(process.argv[appArgIndex + 1] || '');
  const resources = join(appRoot, 'Contents', 'Resources');
  const required = ['funasr_sidecar/main.py', 'funasr_sidecar/tools/generate-python-runtime-notices.py'];
  for (const path of required) {
    try {
      if (!statSync(join(resources, path)).isFile()) throw new Error();
    } catch {
      errors.push(`${relative(projectRoot, appRoot)}/${path}: required packaged runtime evidence is missing`);
    }
  }
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (binaryModelExtensions.has(extname(entry.name).toLowerCase()) && extname(entry.name).toLowerCase() !== '.bin') {
        errors.push(`${relative(projectRoot, path)}: possible model weight in packaged runtime`);
      }
    }
  };
  if (readdirSync(resources).some(entry => entry === 'funasr-runtime')) {
    errors.push(`${relative(projectRoot, appRoot)}: packaged FunASR runtime must be absent`);
  }
  try { walk(resources); } catch { /* required checks report absence */ }
}

if (errors.length) {
  console.error('Release boundary check failed:');
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Release boundary check passed (${candidates.length} candidate source files, ${staged.length} staged files).`);
