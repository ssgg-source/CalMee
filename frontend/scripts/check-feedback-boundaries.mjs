import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve('src');
const extensions = new Set(['.ts', '.tsx']);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (extensions.has(path.extname(entry.name))) files.push(absolute);
  }
}

walk(sourceRoot);
const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
const count = pattern => source.match(pattern)?.length ?? 0;

// This is a ratchet, not a claim that migration is complete. Lower each
// threshold as another product area moves onto the shared feedback helper.
const checks = [
  { name: 'raw errors placed directly in UI descriptions', count: count(/description\s*:\s*(?:String\s*\(|error\s+instanceof\s+Error|payload\.error|job\.error|err\.message)/g), limit: 0 },
  { name: 'backend response messages used as toast copy', count: count(/toast\.(?:success|error|info|warning)\(\s*(?:result\.message|await\s+invoke)/g), limit: 0 },
  { name: 'browser alert calls', count: count(/\balert\s*\(/g), limit: 0 },
  { name: 'legacy literal translations', count: count(/\blt\s*\(/g), limit: 314 },
];

let failed = false;
for (const check of checks) {
  const status = check.count <= check.limit ? '✓' : '✗';
  console.log(`${status} ${check.name}: ${check.count} (limit ${check.limit})`);
  failed ||= check.count > check.limit;
}

const removedLegacyFiles = [
  'components/CustomDialog.tsx',
  'components/ConfirmationModel/confirmation-modal.tsx',
  'components/DatabaseImport/LegacyDatabaseImport.tsx',
  'components/DatabaseImport/HomebrewDatabaseDetector.tsx',
  'components/TranscriptView.tsx',
  'components/Info.tsx',
  'components/Logo.tsx',
  'components/onboarding/steps/DownloadProgressStep.tsx',
];
for (const relative of removedLegacyFiles) {
  const exists = fs.existsSync(path.join(sourceRoot, relative));
  console.log(`${exists ? '✗' : '✓'} removed legacy entry: ${relative}`);
  failed ||= exists;
}

if (failed) {
  console.error('Feedback boundary check failed. Use the shared feedback infrastructure or intentionally lower the legacy baseline.');
  process.exit(1);
}
