/**
 * Electron 模块 stub：用于在普通 Node 进程里跑 e2e 测试。
 * CodingAgent.ts 通过 `import { logger } from './logger'` 间接依赖 electron.app 的 getPath/isPackaged；
 * preload/main 路径不直接 import，但 logger 链路上调用了 electron.ipcMain.on 做日志转发。
 * 这里只暴露 CodingAgent 链路真正用到的最小子集。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpLogDir = path.join(os.tmpdir(), 'macapp-e2e-test-' + Date.now());
fs.mkdirSync(tmpLogDir, { recursive: true });

let logHandler = null;

module.exports = {
  app: {
    isPackaged: false,
    getPath: (key) => {
      if (key === 'userData') return tmpLogDir;
      return tmpLogDir;
    },
    getVersion: () => '0.0.0-e2e',
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  ipcMain: {
    on: (channel, handler) => {
      if (channel === 'log:write') logHandler = handler;
    },
    handle: () => {},
    removeListener: () => {},
  },
  BrowserWindow: class {},
  WebContentsView: class {},
  dialog: {},
  shell: {},
  contextBridge: { exposeInMainWorld: () => {} },
  ipcRenderer: { on: () => {}, invoke: () => Promise.resolve() },
};
