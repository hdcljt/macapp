// 调试用：测试 require('electron') 在 electron 进程下的返回值
const electron = require('electron');
console.log('Type:', typeof electron);
console.log('Is array:', Array.isArray(electron));
console.log('Keys:', Object.keys(electron).slice(0, 10));
console.log('app:', typeof electron.app);
console.log('BrowserWindow:', typeof electron.BrowserWindow);
console.log('First 100 chars:', JSON.stringify(electron).slice(0, 100));
process.exit(0);
