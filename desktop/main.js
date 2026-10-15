// Janela do programa (Electron): liga o servidor Python escondido, mostra a página e,
// ao fechar a janela, desliga o servidor e os núcleos do encaixe junto.
const { app, BrowserWindow, Menu, dialog, nativeTheme } = require('electron');
const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8080;
const URL = `http://127.0.0.1:${PORT}/`;
// instalado: servidor\ ao lado do .exe, com o Python portátil; em desenvolvimento: o repositório
const ROOT = app.isPackaged ? path.join(path.dirname(process.execPath), 'servidor') : path.join(__dirname, '..');
const PY = app.isPackaged ? [path.join(ROOT, 'runtime', 'pythonw.exe')] : ['py', '-3'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
let win = null;

function alive() {
  return new Promise((resolve) => {
    const req = http.get(URL, { timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (await alive()) return true; // já ligado (outra cópia ou desenvolvimento): só usa
  const env = { ...process.env };
  // dados fora da pasta do programa: atualizar ou desinstalar nunca apaga projetos
  if (!env.NEST_DATA) env.NEST_DATA = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'EncaixeChapa', 'data');
  server = spawn(PY[0], [...PY.slice(1), 'server.py'], { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' });
  server.on('exit', () => { server = null; });
  for (let i = 0; i < 100; i++) {
    if (await alive()) return true;
    if (!server) break;
    await sleep(200);
  }
  return false;
}

function stopServer() {
  // /T leva junto os processos do encaixe (núcleos do Python e o motor)
  if (server) execFile('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, show: false,
    title: 'Encaixe Chapa', backgroundColor: '#0b0f14',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // a página avisa ao sair com algo por gravar; aqui ela grava sozinha (keepalive), então a janela fecha
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL)) e.preventDefault(); });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadURL(URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    nativeTheme.themeSource = 'dark'; // barra de título escura, como a página
    if (!(await startServer())) {
      dialog.showErrorBox('Encaixe Chapa', `O servidor não ligou. Outro programa pode estar usando a porta ${PORT}.`);
      stopServer();
      app.quit();
      return;
    }
    createWindow();
  });
  app.on('window-all-closed', async () => {
    await sleep(2500); // tempo para a página terminar de gravar
    stopServer();
    app.quit();
  });
}
