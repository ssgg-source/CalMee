import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDir = path.resolve(frontendDir, '..');
const packagePath = path.join(frontendDir, 'package.json');
const tauriConfigPath = path.join(frontendDir, 'src-tauri', 'tauri.conf.json');
const cargoManifestPath = path.join(frontendDir, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(repositoryDir, 'Cargo.lock');

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const cargoManifest = fs.readFileSync(cargoManifestPath, 'utf8');
const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');

const cargoVersion = cargoManifest.match(/^version = "([^"]+)"/m)?.[1];
const lockVersion = cargoLock.match(/\[\[package\]\]\nname = "calmee"\nversion = "([^"]+)"/)?.[1];
const versions = {
  'frontend/package.json': packageJson.version,
  'frontend/src-tauri/tauri.conf.json': tauriConfig.version,
  'frontend/src-tauri/Cargo.toml': cargoVersion,
  'Cargo.lock': lockVersion,
};

if (process.argv[2] === '--check') {
  const uniqueVersions = new Set(Object.values(versions));
  if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
    console.error('CalMee version mismatch:');
    for (const [file, version] of Object.entries(versions)) {
      console.error(`  ${file}: ${version ?? 'missing'}`);
    }
    process.exit(1);
  }
  console.log(`CalMee version ${packageJson.version} is synchronized.`);
  process.exit(0);
}

const nextVersion = process.argv[2];
if (!nextVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error('Usage: pnpm version:set <semver>  (example: pnpm version:set 0.1.0-beta.1)');
  process.exit(1);
}

packageJson.version = nextVersion;
tauriConfig.version = nextVersion;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 4)}\n`);
fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
fs.writeFileSync(
  cargoManifestPath,
  cargoManifest.replace(/^version = "[^"]+"/m, `version = "${nextVersion}"`),
);
fs.writeFileSync(
  cargoLockPath,
  cargoLock.replace(
    /(\[\[package\]\]\nname = "calmee"\nversion = ")[^"]+("\n)/,
    `$1${nextVersion}$2`,
  ),
);
console.log(`CalMee version updated to ${nextVersion}.`);
