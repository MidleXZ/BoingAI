#!/usr/bin/env node
/**
 * Stages the native services and frontend into desktop/resources/boingai so
 * electron-builder can ship them as extraResources.
 *
 * Usage: node .github/scripts/stage-resources.js <linux|win|mac>
 */
const fs = require('fs');
const path = require('path');

const platform = process.argv[2];
if (!['linux', 'win', 'mac'].includes(platform)) {
  console.error('Usage: node .github/scripts/stage-resources.js <linux|win|mac>');
  process.exit(1);
}

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'boingai');
const destRoot = path.join(root, 'desktop', 'resources');
const dest = path.join(destRoot, 'boingai');

const isWin = platform === 'win';
const isMac = platform === 'mac';
const exe = isWin ? '.exe' : '';
const libName = isWin ? 'boing_text.dll' : isMac ? 'libboing_text.dylib' : 'libboing_text.so';

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${label}: ${p}`);
    process.exit(1);
  }
  return p;
}

function findRustBinary() {
  const candidates = [
    path.join(src, 'rust-server', 'target', 'release', `boingai-server${exe}`),
    path.join(src, 'rust-server', 'target', 'aarch64-apple-darwin', 'release', `boingai-server${exe}`),
    path.join(src, 'rust-server', 'target', 'x86_64-apple-darwin', 'release', `boingai-server${exe}`),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error('Missing Rust server binary. Candidates:\n  ' + candidates.join('\n  '));
    process.exit(1);
  }
  return found;
}

function findCSharpPublish() {
  const dir = path.join(root, 'staging', 'csharp');
  mustExist(dir, 'C# publish output');
  const exeName = `csharp-service${exe}`;
  if (!fs.existsSync(path.join(dir, exeName))) {
    console.error(`Missing C# executable in ${dir}: ${exeName}`);
    process.exit(1);
  }
  return dir;
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// 1. Frontend (served by the Rust server at runtime)
fs.cpSync(mustExist(path.join(src, 'frontend'), 'frontend'), path.join(dest, 'frontend'), {
  recursive: true,
});

// 2. Native C++ text library
const libDir = path.join(dest, 'cpp-lib');
fs.mkdirSync(libDir, { recursive: true });
const libSrc = mustExist(path.join(src, 'cpp-lib', libName), libName);
fs.copyFileSync(libSrc, path.join(libDir, libName));

// 3. Rust backend
const rustDir = path.join(dest, 'rust-server');
fs.mkdirSync(rustDir, { recursive: true });
const rustBin = findRustBinary();
const rustDest = path.join(rustDir, `boingai-server${exe}`);
fs.copyFileSync(rustBin, rustDest);
if (!isWin) fs.chmodSync(rustDest, 0o755);

// On macOS the dylib uses @loader_path, so it must sit next to the binary too.
if (isMac) {
  fs.copyFileSync(libSrc, path.join(rustDir, libName));
}

// 4. Published C# memory service
const csDir = findCSharpPublish();
fs.cpSync(csDir, path.join(dest, 'csharp-service'), { recursive: true });
if (!isWin) {
  const csExe = path.join(dest, 'csharp-service', 'csharp-service');
  if (fs.existsSync(csExe)) fs.chmodSync(csExe, 0o755);
}

console.log(`Staged resources for ${platform} at ${dest}`);
