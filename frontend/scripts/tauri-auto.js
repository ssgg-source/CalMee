#!/usr/bin/env node
/**
 * Auto-detect GPU and run Tauri with appropriate features
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Get the command (dev or build)
const command = process.argv[2];
if (!command || !['dev', 'build'].includes(command)) {
  console.error('Usage: node tauri-auto.js [dev|build]');
  process.exit(1);
}

// Detect GPU feature
let feature = '';

// Check for environment variable override first
if (process.env.TAURI_GPU_FEATURE) {
  feature = process.env.TAURI_GPU_FEATURE;
  console.log(`🔧 Using forced GPU feature from environment: ${feature}`);
} else {
  try {
    const result = execSync('node scripts/auto-detect-gpu.js', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    });
    feature = result.trim();
  } catch (err) {
    // If detection fails, continue with no features
  }
}

console.log(''); // Empty line for spacing

// Platform-specific environment variables
const platform = os.platform();
const env = { ...process.env };

// A previous interrupted Tauri dev session can leave either its Next.js child
// or the debug CalMee process alive. The latter keeps the single-instance lock,
// while a detached Next process may no longer listen on port 3119. In that
// state a new `tauri dev` exits immediately and the old WebView becomes inert
// as soon as it needs another chunk. Stop only processes that resolve to this
// exact checkout; never terminate an unrelated CalMee install or Next service.
if (command === 'dev' && platform === 'darwin') {
  const frontendDir = fs.realpathSync(path.join(__dirname, '..'));
  const repositoryDir = fs.realpathSync(path.join(frontendDir, '..'));
  const debugBinary = path.join(repositoryDir, 'target', 'debug', 'calmee');
  const stalePids = new Set();

  const processCwd = (pid) => {
    try {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      const line = output.split('\n').find(item => item.startsWith('n'));
      return line ? fs.realpathSync(line.slice(1)) : '';
    } catch {
      return '';
    }
  };

  try {
    const processList = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    for (const line of processList.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const processCommand = match[2];
      const isThisDebugApp = processCommand === debugBinary || processCommand.startsWith(`${debugBinary} `);
      const isThisNextDev = processCommand.includes('next') && processCommand.includes('dev -p 3119') && processCwd(pid) === frontendDir;
      if (isThisDebugApp || isThisNextDev) stalePids.add(pid);
    }

    let listeningPids = [];
    try {
      const output = execFileSync('lsof', ['-tiTCP:3119', '-sTCP:LISTEN'], { encoding: 'utf8' });
      listeningPids = output.split(/\s+/).map(Number).filter(Number.isFinite);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    for (const pid of listeningPids) {
      if (!stalePids.has(pid)) {
        console.error(`Port 3119 is used by an unrelated process (PID ${pid}). Stop it before starting CalMee.`);
        process.exit(1);
      }
    }

    for (const pid of stalePids) {
      process.kill(pid, 'SIGTERM');
      console.log(`🧹 Stopped stale CalMee development process ${pid}`);
    }
    // Give the single-instance lock and listening socket time to be released
    // before Tauri runs its beforeDevCommand.
    if (stalePids.size) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Watchpack's native macOS watcher can exhaust the per-process watcher quota
// in this large pnpm/Tauri workspace. When that happens Next.js silently
// discovers only the 404 route, leaving a visible shell whose buttons appear
// to do nothing. Polling is a little less elegant, but is reliable in dev and
// does not affect production builds.
if (command === 'dev' && platform === 'darwin' && !env.WATCHPACK_POLLING) {
  env.WATCHPACK_POLLING = 'true';
  env.WATCHPACK_POLLING_INTERVAL = '1000';
}

// WKWebView can retain Next.js development chunks under stable names such as
// `app/layout.js`. After a hot reload or an interrupted rebuild, its network
// cache may keep a stale webpack runtime and the whole UI becomes an inert
// ChunkLoadError screen. Clear only the disposable WebKit *network cache*
// before launching a macOS dev build. Application data, models, recordings,
// cookies and localStorage live elsewhere and are intentionally preserved.
if (command === 'dev' && platform === 'darwin') {
  // A stopped or hot-reloaded Next process can leave a partially written
  // webpack graph behind. It is fully disposable and must not be reused by a
  // fresh Tauri WebView, otherwise app/layout.js can time out at startup.
  const nextDevOutput = path.join(__dirname, '..', '.next-dev');
  try {
    fs.rmSync(nextDevOutput, { recursive: true, force: true });
  } catch (error) {
    console.warn(`⚠️ Could not clear Next.js development output at ${nextDevOutput}: ${error.message}`);
  }

  const webkitNetworkCaches = [
    path.join(os.homedir(), 'Library', 'Caches', 'calmee', 'WebKit', 'NetworkCache'),
    path.join(os.homedir(), 'Library', 'Caches', 'com.calmee.app', 'WebKit', 'NetworkCache'),
  ];

  for (const cachePath of webkitNetworkCaches) {
    try {
      fs.rmSync(cachePath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`⚠️ Could not clear WebView network cache at ${cachePath}: ${error.message}`);
    }
  }
  console.log('🧹 Cleared Next.js development output and macOS WebView network cache');
}

if (platform === 'linux' && feature === 'cuda') {
  console.log('🐧 Linux/CUDA detected: Setting CMAKE flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES = '75';
  env.CMAKE_CUDA_STANDARD = '17';
  env.CMAKE_POSITION_INDEPENDENT_CODE = 'ON';
}

// Build the tauri command
let tauriCmd = `tauri ${command}`;
if (feature && feature !== 'none') {
  tauriCmd += ` -- --features ${feature}`;
  console.log(`🚀 Running: tauri ${command} with features: ${feature}`);
} else {
  console.log(`🚀 Running: tauri ${command} (CPU-only mode)`);
}
console.log('');

// Execute the command
try {
  execSync(tauriCmd, { stdio: 'inherit', env });
} catch (err) {
  process.exit(err.status || 1);
}
