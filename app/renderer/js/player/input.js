'use strict';
/*
 * 输入管理：指针锁定、键鼠状态、视角增量、滚轮切槽。
 * UI 打开时通过 setUIMode(true) 屏蔽玩法按键，只保留 Esc / E。
 */
const KEYMAP = {
  KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D',
  Space: 'jump', ControlLeft: 'sprint', ControlRight: 'sprint',
  ShiftLeft: 'sneak', ShiftRight: 'sneak'
};

/* BUG.1：双击判定的纯函数（可无头单测）。窗口与「双击空格起飞」保持一致。 */
export function isDoubleTap(lastAt, now, windowMs = 320) {
  const d = now - lastAt;
  return lastAt > 0 && d >= 0 && d < windowMs;
}

export class InputManager {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers || {};
    this.keys = Object.create(null);
    this.state = {
      keyW: false, keyA: false, keyS: false, keyD: false,
      jump: false, sprint: false, sneak: false,
      mouseLeft: false, mouseRight: false
    };
    this.lookDelta = { x: 0, y: 0 };
    this.locked = false;
    this.uiMode = false;
    this._lastDoubleSpace = 0;
    /* BUG.1：中文 Windows 下 Ctrl+Space 是输入法开关，冲刺键(左 Ctrl)与跳跃键(Space)
       同时按会被 IME 吃掉。补一条 Minecraft 默认的「双击 W 冲刺」，不依赖 Ctrl。 */
    this._sprintLatch = false;
    this._lastWDown = 0;
    this.lockRequests = 0;      // BUG.2：诊断用，证明 closeUI 真的请求过重新锁指针
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => this._onKey(e, true), { capture: true });
    window.addEventListener('keyup', (e) => this._onKey(e, false), { capture: true });
    window.addEventListener('blur', () => this._clearAll());
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('mouseup', (e) => this._onMouseUp(e));
    window.addEventListener('mousemove', (e) => this._onMouseMove(e));
    window.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.h.onLockChanged) this.h.onLockChanged(this.locked);
    });
    document.addEventListener('contextmenu', (e) => { if (!this.uiMode) e.preventDefault(); });
  }

  requestLock() {
    if (this.uiMode) return;
    this.lockRequests++;
    if (this.canvas.requestPointerLock) {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { });
    }
  }

  releaseLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  setUIMode(v) {
    this.uiMode = !!v;
    if (v) { this.releaseLock(); this._clearAll(); }
  }

  _clearAll() {
    this.keys = Object.create(null);
    this.state.mouseLeft = this.state.mouseRight = false;
    this._sprintLatch = false;
    this._lastWDown = 0;
  }

  _onKey(e, down) {
    // UI 打开时只放行少数键
    if (this.uiMode) {
      /* E1：搜索框等输入控件获得焦点时，E/I 不能关闭界面，字母数字也不能落到玩法键；
         Escape 仍交给全局关闭逻辑。 */
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (down && e.code === 'Escape' && this.h.onKey) { this.h.onKey(e.code, e); return; }
        if (e.code === 'Tab') e.preventDefault();
        return;
      }
      if (down && (e.code === 'Escape' || e.code === 'KeyE' || e.code === 'KeyI')) {
        if (this.h.onKey) this.h.onKey(e.code, e);
        return;
      }
      if (e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    /* BUG.1：双击 W 冲刺。320ms 内第二次按下 W 就锁住冲刺，松开 W 才解除；
       与原有左 Ctrl 冲刺并存，互不干扰。 */
    if (e.code === 'KeyW') {
      if (down) {
        /* P0：OS 按键重复会在 320ms 窗口内连发 keydown，若不排除 e.repeat，
           按住 W 不放会被误判成「双击 W」而自动冲刺（原版体验优化提示词已复现）。 */
        if (!e.repeat) {
          const now = performance.now();
          if (isDoubleTap(this._lastWDown, now)) this._sprintLatch = true;
          this._lastWDown = now;
        }
      } else this._sprintLatch = false;
    }
    const mapped = KEYMAP[e.code];
    if (mapped) {
      this.keys[mapped] = down;
      e.preventDefault();
      // D5 修复：双击检测原来整段被 `this.h.onJumpDown` 的存在与否挡住，而 game.js 从没传这个回调，
      // 于是 onDoubleJump（双击空格起飞）永远不会触发。现在与 onJumpDown 解耦。
      if (down && mapped === 'jump') {
        if (this.h.onJumpDown) this.h.onJumpDown();
        const now = performance.now();
        if (now - this._lastDoubleSpace < 320) { if (this.h.onDoubleJump) this.h.onDoubleJump(); }
        this._lastDoubleSpace = now;
      }
    }
    if (down && this.h.onKey) this.h.onKey(e.code, e);
    if (e.code.startsWith('Digit')) {
      const n = parseInt(e.code.slice(5), 10);
      if (n >= 1 && n <= 9) { this.state.hotbarKey = n - 1; if (down && this.h.onSelectSlot) this.h.onSelectSlot(n - 1); }
    }
    if (down && (e.code === 'Space' || e.code === 'Tab' || e.code === 'F5' || e.code === 'F11' || e.code === 'F12' || e.code === 'F3')) e.preventDefault();
    this.sync();
  }

  _onMouseDown(e) {
    if (this.uiMode) return;
    if (!this.locked) { this.requestLock(); if (this.h.onCanvasClick) this.h.onCanvasClick(); return; }
    if (e.button === 0) this.state.mouseLeft = true;
    if (e.button === 2) { this.state.mouseRight = true; if (this.h.onRightDown) this.h.onRightDown(); }
    if (e.button === 1 && this.h.onMiddleDown) this.h.onMiddleDown();
    this.sync();
  }

  _onMouseUp(e) {
    if (e.button === 0) { this.state.mouseLeft = false; if (this.h.onLeftUp) this.h.onLeftUp(); }
    if (e.button === 2) this.state.mouseRight = false;
    this.sync();
  }

  _onMouseMove(e) {
    if (!this.locked || this.uiMode) return;
    const sens = (this.h.getSensitivity ? this.h.getSensitivity() : 0.0022);
    if (this.h.onLook) this.h.onLook(e.movementX || 0, e.movementY || 0, sens);
  }

  _onWheel(e) {
    if (this.uiMode) return;
    e.preventDefault();
    if (this.h.onScroll) this.h.onScroll(e.deltaY > 0 ? 1 : -1);
  }

  sync() {
    const k = this.keys;
    this.state.keyW = !!k.W; this.state.keyA = !!k.A; this.state.keyS = !!k.S; this.state.keyD = !!k.D;
    this.state.jump = !!k.jump;
    this.state.sprint = !!(k.sprint || this._sprintLatch);
    this.state.sneak = !!k.sneak;
    return this.state;
  }

  /* 触控/无鼠标场景：外部注入虚拟摇杆输入 */
  setVirtual(dir) { this.state.pointerDir = dir; }
}
