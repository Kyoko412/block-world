'use strict';
/*
 * 前端启动：装配 Game 与 UI，暴露 window.__game / window.__test 供自动化验收使用。
 * 任何模块加载失败都会在界面上显示中文错误，便于离线排查。
 */
import { Game } from './player/game.js';
import { UI } from './ui/ui.js';
import { initAtlas } from './gfx/atlas.js';

/*
 * D1：区分「启动期致命错误」与「运行期单次异常」。
 * 启动期 → 弹中文红框（画面还没起来，必须告诉玩家为什么打不开）。
 * 运行期 → 只 console + 计数记录，绝不弹红框盖住正在跑的游戏（以前一次渲染抖动就会糊住整屏）。
 */
let bootDone = false;
window.__bootErrorShown = false;
window.__runtimeErrors = [];

function fatal(err, where) {
  const text = (err && (err.stack || err.message)) || String(err);
  console.error('[方块世界] ' + (where || 'fatal') + ': ' + text);
  if (bootDone) {
    window.__runtimeErrors.push(String(text).split('\n')[0]);
    return;
  }
  const box = document.getElementById('boot-error');
  if (box) {
    box.classList.remove('hidden');
    box.textContent = '启动出错：' + ((err && err.message) ? err.message : String(err)) +
      '\n\n' + String(text).split('\n').slice(0, 6).join('\n');
    box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'background:rgba(20,0,0,.92);color:#fff;padding:18px 22px;font:14px "Microsoft YaHei",sans-serif;' +
      'border:2px solid #a33;max-width:80vw;white-space:pre-wrap;z-index:999';
    window.__bootErrorShown = true;
  }
}
window.addEventListener('error', (e) => fatal(e.error || e.message, 'error'));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason, 'rejection'));

const canvas = document.getElementById('game-canvas');
const game = new Game(canvas);
const ui = new UI(game);
game.ui = ui;

try {
  initAtlas();
} catch (e) { fatal(e, 'atlas'); }

try {
  await game.init(ui);
} catch (e) { fatal(e, 'init'); }
bootDone = true;
window.__game = game;
window.__test = game.testApi();
window.__version = '1.0.0';

// 点击画面锁定鼠标（仅在游戏中）
canvas.addEventListener('click', () => {
  if (game.state === 'playing' && !game.openUI) {
    game.sfx.resume();
    game.input.requestLock();
  }
});

ui.showMenu();
game.resize();
console.log('方块世界已就绪（离线模式）');
