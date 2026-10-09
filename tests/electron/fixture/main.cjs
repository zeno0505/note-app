const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
app.enableSandbox();
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 840, height: 640, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'preload.cjs')
  }});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  ipcMain.handle('harness:ping', (event, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || input !== 'ping') throw new Error('Invalid request');
    return { value: 'pong', electron: process.versions.electron };
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
