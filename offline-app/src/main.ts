// 必须第一个 import：包装 console.{log,info,warn,error,debug} 转发到主进程日志文件
// 详见 electron-logger-bridge.ts
import './electron-logger-bridge';

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import './styles/global.scss';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);
app.mount('#app');
