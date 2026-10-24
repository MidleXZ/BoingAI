const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const EXE = isWin ? '.exe' : '';

const ROOT = path.resolve(__dirname, '..');
// In a packaged build the services/frontend are shipped via extraResources
// under <resources>/boingai. In development they live next to this repo.
const BOING = app.isPackaged
  ? path.join(process.resourcesPath, 'boingai')
  : path.join(ROOT, 'boingai');

let mainWindow = null;
let rustProc = null;
let csharpProc = null;

function isUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

function dotnetCommand() {
  if (process.env.DOTNET) return process.env.DOTNET;
  const snap = '/snap/dotnet-sdk-100/current/usr/bin/dotnet';
  if (!isWin && !isMac && fs.existsSync(snap)) return snap;
  return 'dotnet';
}

function addLibPath(env) {
  const libDir = path.join(BOING, 'cpp-lib');
  if (isWin) {
    env.PATH = libDir + path.delimiter + (env.PATH || '');
  } else if (isMac) {
    env.DYLD_LIBRARY_PATH = libDir + (env.DYLD_LIBRARY_PATH ? path.delimiter + env.DYLD_LIBRARY_PATH : '');
  } else {
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? path.delimiter + env.LD_LIBRARY_PATH : '');
  }
  return env;
}

async function startServices() {
  const env = Object.assign({}, process.env);

  if (!(await isUp('http://localhost:5001/health'))) {
    if (app.isPackaged) {
      const csDir = path.join(BOING, 'csharp-service');
      csharpProc = spawn(path.join(csDir, 'csharp-service' + EXE), [], {
        cwd: csDir,
        env,
        stdio: 'ignore',
      });
    } else {
      csharpProc = spawn(dotnetCommand(), ['run', '--no-build'], {
        cwd: path.join(BOING, 'csharp-service'),
        env,
        stdio: 'ignore',
      });
    }
  }

  if (!(await isUp('http://localhost:8080/health'))) {
    const rustEnv = addLibPath(Object.assign({}, env, {
      FRONTEND_DIR: path.join(BOING, 'frontend'),
      CSHARP_URL: 'http://localhost:5001',
      OLLAMA_URL: 'http://localhost:11434',
      MODEL: 'minicpm-v4.6:1b',
    }));
    const rustBin = app.isPackaged
      ? path.join(BOING, 'rust-server', 'boingai-server' + EXE)
      : path.join(BOING, 'rust-server', 'target', 'debug', 'boingai-server' + EXE);
    rustProc = spawn(rustBin, [], {
      cwd: path.dirname(rustBin),
      env: rustEnv,
      stdio: 'ignore',
    });
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (await isUp('http://localhost:8080/health')) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    // NOTE: do not use `frame: false` on this setup — frameless surfaces fail to
    // rasterize text here. `titleBarStyle: 'hidden'` removes the OS title bar
    // while keeping a normal (text-rendering) window surface.
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    autoHideMenuBar: true,
    backgroundColor: '#fafaf9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(BOING, 'frontend', 'logo.png'),
  });

  mainWindow.loadURL('http://localhost:8080');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  await startServices();
  await waitForServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (rustProc) rustProc.kill();
  if (csharpProc) csharpProc.kill();
  app.quit();
});

ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
  else { mainWindow.maximize(); return true; }
});
ipcMain.handle('win:close', () => mainWindow && mainWindow.close());
ipcMain.handle('win:isMaximized', () => mainWindow && mainWindow.isMaximized());
ipcMain.handle('win:fullscreen', () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});
ipcMain.handle('win:isFullScreen', () => mainWindow && mainWindow.isFullScreen());
