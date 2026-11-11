/* 浏览器测试模式：只启动本地服务并打印地址，方便用自动化测试驱动同一份游戏代码 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const srv = await createServer({
  staticRoot: path.join(__dirname, '..', 'renderer'),
  saveRoot: path.join(__dirname, '..', 'saves'),
  port: parseInt(process.env.PORT || '0', 10)
});
console.log('开发服务器（仅监听 127.0.0.1，完全离线）');
console.log('  游戏地址: ' + srv.url);
console.log('  存档目录: ' + srv.saveRoot);
