'use strict';
/*
 * 渲染层：three 场景 + 自定义体素着色器（承载天空光 / 方块光 / AO / 雾），
 * 负责区块网格创建与销毁、选中框、挖掘破坏动画、视距与雾联动、昼夜环境。
 */
import * as THREE from '../../vendor/three.module.js';
import { initAtlas, getWaterTexture } from './atlas.js';
import { buildChunkGeometry } from '../world/mesher.js';
import { SkyDome } from './sky.js';
import { weatherLight, weatherFog } from '../core/weather.js';

const VOX_VERT = `
attribute vec3 aLight;
varying vec2 vUv;
varying vec3 vLight;
varying float vFogDist;
void main() {
  vUv = uv;
  vLight = aLight;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const VOX_FRAG = `
precision highp float;
uniform sampler2D uMap;
uniform float uDay;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlpha;
uniform float uAlphaTest;
uniform vec2 uUvOffset;
uniform float uBrightness;
varying vec2 vUv;
varying vec3 vLight;
varying float vFogDist;
void main() {
  vec4 tex = texture2D(uMap, vUv + uUvOffset);
  if (tex.a < uAlphaTest) discard;
  float skyL = vLight.r * uDay;
  float blkL = vLight.g;
  float lvl = max(skyL, blkL);
  /* P0 光池：以前只有一条接近线性的曲线（pow 1.12），所以火把照到的地方和
     五六格外的远墙亮度只差一点，洞穴看起来「整片发灰、光没有落在地上」。
     现在按「方块光主导程度」混合两条曲线：
       - 天空光主导（白天露天、无火把这）仍用平坦曲线，逐像素与改动前一致，
         这样「白天不许比现在暗」是结构性保证，而不是靠事后调参；
       - 方块光主导（火把/熔炉旁）用 pow 1.8 的陡曲线，做出近处亮、远处暗的光池。
     实测：白天 blkDom=0；火把旁 blkL=0.93/skyL=1（露天）也是 0 → 只有室内与夜间火把旁会变。 */
  float bFlat = 0.065 + 0.935 * pow(lvl, 1.12);
  float bPool = 0.045 + 0.955 * pow(lvl, 1.80);
  float blkDom = clamp((blkL - skyL) / max(0.001, blkL + skyL), 0.0, 1.0);
  float b = mix(bFlat, bPool, blkDom);
  vec3 col = tex.rgb * b * vLight.b * uBrightness;
  /* 火把色温：只给光池加暖（红 +7.5%、蓝 -12.5%，亮度权重 0.2126/0.7152/0.0722
     加起来约守恒 → 不靠提亮或压暗伪装「氛围」）。 */
  col *= mix(vec3(1.0), vec3(1.075, 0.985, 0.875), blkDom * smoothstep(0.02, 0.30, lvl));
  /* P0 暗部校准：补了输出编码后，sRGB 对低线性值增益最大（0.07→约 0.29），
     洞穴/夜间会整片发灰失去暗部。判据用「最终颜色亮度」而不是光照等级
     （实测洞穴场景的 lvl 本来就高，用 lvl 补偿完全不生效）。
     白天草地 lum 高，系数恒为 1；火把近处也保持暖色梯度。 */
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(0.28, 1.0, smoothstep(0.02, 0.30, lum));
  float t = clamp((vFogDist - uFogNear) / max(0.001, uFogFar - uFogNear), 0.0, 1.0);
  col = mix(col, uFogColor, t * t);
  gl_FragColor = vec4(col, uAlpha * tex.a);
  /* P0 色彩空间：renderer.outputColorSpace = SRGBColorSpace，但自定义 ShaderMaterial
     不会自动做输出编码。缺这一步时线性计算的结果被直接写进 sRGB framebuffer，
     晴天草地偏黑、远景变成与天空脱节的蓝色剪影、火把附近发灰。
     A/B（artifacts/visual/ab-20261105-before|after）已验证补上后层次恢复。
     只补体素：sky.js 是另一套混用硬编码 sRGB 数值的 shader，entities/lightning
     用内置 MeshBasicMaterial（Three.js 自动处理），不能一刀切。 */
  #include <colorspace_fragment>
}`;

export class WorldView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.world = opts.world || null;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false,
      powerPreference: 'high-performance'
    });
    this.pixelRatioBase = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatioBase);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x8ac4ff, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.06, 300);
    this.camera.rotation.order = 'YXZ';

    this.atlas = initAtlas();
    this.sky = new SkyDome(this.scene);

    const shared = {
      uDay: { value: 1 },
      uFogColor: { value: new THREE.Color(0x8ac4ff) },
      uFogNear: { value: 70 },
      uFogFar: { value: 100 },
      uBrightness: { value: opts.brightness === undefined ? 1 : opts.brightness }
    };
    this.uniforms = shared;

    const mkMat = (map, alpha, alphaTest, side, transparent, depthWrite) => new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uMap: { value: map },
        uAlpha: { value: alpha },
        uAlphaTest: { value: alphaTest },
        uUvOffset: { value: new THREE.Vector2() }
      }, shared),
      vertexShader: VOX_VERT,
      fragmentShader: VOX_FRAG,
      /* 体素的雾在 VOX_FRAG 里自己做（mix(col, uFogColor, t*t)）；
         这里必须显式 fog:false —— Material.fog 默认是 true，一旦 scene.fog 存在，
         three 就会来刷 fogColor/fogNear/fogFar 这三个我们没声明的 uniform。 */
      side, transparent: !!transparent, depthWrite: depthWrite !== false, fog: false
    });

    this.matOpaque = mkMat(this.atlas.texture, 1, 0.5, THREE.FrontSide, false, true);
    this.matCutout = mkMat(this.atlas.texture, 1, 0.5, THREE.DoubleSide, false, true);
    /* 第二轮 B1：alpha 0.78 → 0.62 —— 浅水能读出岸底，深水仍不透。 */
    this.matWater = mkMat(getWaterTexture(), 0.62, 0.02, THREE.DoubleSide, true, false);

    /* 选中框 */
    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    this.selEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 })
    );
    box.dispose();
    this.selEdges.visible = false;
    this.selEdges.renderOrder = 5;
    this.scene.add(this.selEdges);

    /* 挖掘破坏覆盖层 */
    this.atlas.crackTexture.wrapS = THREE.RepeatWrapping;
    this.atlas.crackTexture.wrapT = THREE.RepeatWrapping;
    this.atlas.crackTexture.repeat.set(0.1, 1);
    this.crackMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.008, 1.008, 1.008),
      new THREE.MeshBasicMaterial({
        map: this.atlas.crackTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5
      })
    );
    this.crackMesh.visible = false;
    this.crackMesh.renderOrder = 6;
    this.scene.add(this.crackMesh);

    this.renderDistance = opts.renderDistance || 6;
    this.setRenderDistance(this.renderDistance);
    this.setFov(opts.fov || 70);
    this.triangles = 0;
  }

  setWorld(world) { this.world = world; }

  /* ---------- 尺寸与设置 ---------- */
  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  applySettings(s) {
    if (s.renderDistance !== undefined) this.setRenderDistance(s.renderDistance);
    if (s.fov !== undefined) this.setFov(s.fov);
    if (s.brightness !== undefined) {
      this.uniforms.uBrightness.value = s.brightness;
      for (const m of [this.matWater]) { /* 共享 uniform 对象，无需单独设置 */ }
    }
    if (s.renderScale !== undefined) {
      this.renderer.setPixelRatio(Math.max(0.5, Math.min(this.pixelRatioBase * s.renderScale, 2)));
      this.renderer.setSize(this._lastW || 1280, this._lastH || 720, false);
    }
  }

  setRenderDistance(chunks) {
    this.renderDistance = chunks;
    this.camera.far = chunks * 16 + 140;
    this.camera.updateProjectionMatrix();
    const dist = chunks * 16 - 8;
    /* 本轮 B：雾的起点往后挪。
       旧值是 near = dist*0.5（视距 6 → 40 格）—— 40 格外的地形就开始淡进雾色，
       而 40 格在这个游戏里还是「中景」，于是半个屏幕都被雾洗成浅蓝。
       现在 near = dist*0.70（67 格）、far = dist（88 格）：近中景保留材质与颜色，
       只有真正接近视距边缘的远景才过渡，过渡带也更短、更「收」。
       同时把可见地平线的对比留在地形自己的明暗上，而不是靠雾把它糊掉。 */
    this.baseFogNear = Math.max(12, dist * 0.70);
    this.baseFogFar = Math.max(28, dist);
    this.uniforms.uFogNear.value = this.baseFogNear;
    this.uniforms.uFogFar.value = this.baseFogFar;
  }

  setFov(deg) {
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- 区块网格 ---------- */
  rebuildChunk(chunk) {
    const world = this.world;
    if (!world) return;
    const data = buildChunkGeometry(chunk, world);
    this.removeChunk(chunk);
    const mk = (geo, mat, order) => {
      if (!geo) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(geo.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(geo.normal, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(geo.uv, 2));
      g.setAttribute('aLight', new THREE.BufferAttribute(geo.color, 3));
      g.setIndex(new THREE.BufferAttribute(geo.index, 1));
      g.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(chunk.cx * 16 + 8, 32, chunk.cz * 16 + 8),
        Math.sqrt(8 * 8 + 8 * 8 + 64 * 64)
      );
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.name = 'chunk-' + chunk.cx + '-' + chunk.cz;
      this.scene.add(m);
      return m;
    };
    chunk.meshes = [
      mk(data.opaque, this.matOpaque, 0),
      mk(data.cutout, this.matCutout, 1),
      mk(data.water, this.matWater, 2)
    ].filter(Boolean);
    chunk.meshed = chunk.meshes.length > 0;
  }

  removeChunk(chunk) {
    if (!chunk.meshes || !chunk.meshes.length) return;
    for (const m of chunk.meshes) {
      this.scene.remove(m);
      if (m.geometry) m.geometry.dispose();
    }
    chunk.meshes = [];
    chunk.meshed = false;
  }

  /* ---------- 选中框 / 破坏动画 ---------- */
  setSelection(hit) {
    if (!hit) { this.selEdges.visible = false; return; }
    this.selEdges.visible = true;
    this.selEdges.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  }

  setBreakProgress(hit, progress) {
    if (!hit || !progress || progress <= 0) { this.crackMesh.visible = false; return; }
    this.crackMesh.visible = true;
    this.crackMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    const stage = Math.max(0, Math.min(9, Math.floor(progress * 10)));
    this.atlas.crackTexture.offset.set(stage * 0.1, 0);
  }

  /* ---------- 环境（昼夜/雾/水下/天气） ---------- */
  updateEnvironment(timeOfDay, elapsed, camPos, underwater, weather) {
    const r = this.sky.update(timeOfDay, elapsed, camPos, underwater, weather);
    const wi = Math.max(0, Math.min(1, (weather && weather.intensity) || 0));
    const storm = !!(weather && weather.storm && weather.type === 'rain');
    const lightMul = wi > 0 ? (1 - wi * (1 - weatherLight(weather.type, storm))) : 1;
    /* V6：夜间保底从 0.30 抬到 0.36——保留轮廓与操作可读性，但白天仍是 1.0，不会“晚上像白天” */
    this.uniforms.uDay.value = (0.36 + 0.64 * r.dayFactor) * lightMul;
    this.uniforms.uFogColor.value.copy(this.sky.fogColor);
    // 降水时视距变短（雨最明显，雷暴再短一档）：以 setRenderDistance 记下的基准值缩放
    const fogMul = wi > 0 ? (1 / (1 + wi * (weatherFog(weather.type, storm) - 1))) : 1;
    if (this.baseFogNear !== undefined) {
      if (fogMul < 1) {
        this.uniforms.uFogNear.value = Math.max(6, this.baseFogNear * fogMul);
        this.uniforms.uFogFar.value = Math.max(18, this.baseFogFar * fogMul);
      } else {
        this.uniforms.uFogNear.value = this.baseFogNear;
        this.uniforms.uFogFar.value = this.baseFogFar;
      }
    }
    this.renderer.setClearColor(this.sky.fogColor, 1);
    /* P1：实体（生物/掉落物/箭/天气粒子）用的是内置 MeshBasicMaterial / PointsMaterial，
       它们读的是 scene.fog，而体素的雾是 VOX_FRAG 里手写的 —— 以前 scene.fog 从来没设过，
       所以远处生物不会淡出，像贴在风景上的纯色贴纸（验收报告已知问题 #28）。
       这里把**同一份颜色与同样的 near/far**喂给 scene.fog：内置雾是线性插值、
       体素是 t²，中段会比地形略浓一点，但近处起点与远处终点完全一致，颜色也同源，
       不会像以前那样「地形已经白了，生物还是饱和的」。天空穹顶自己标了 fog:false，不受影响。 */
    if (!this.scene.fog) this.scene.fog = new THREE.Fog(this.uniforms.uFogColor.value.getHex(),
      this.uniforms.uFogNear.value, this.uniforms.uFogFar.value);
    else {
      this.scene.fog.color.copy(this.uniforms.uFogColor.value);
      this.scene.fog.near = this.uniforms.uFogNear.value;
      this.scene.fog.far = this.uniforms.uFogFar.value;
    }
    const wu = this.matWater.uniforms.uUvOffset.value;
    wu.set(Math.sin(elapsed * 0.25) * 0.06 + (elapsed * 0.02) % 1, Math.cos(elapsed * 0.2) * 0.06);
    return r;
  }

  render() {
    this._lastW = this._lastW || this.canvas.clientWidth || 1280;
    this._lastH = this._lastH || this.canvas.clientHeight || 720;
    this.renderer.render(this.scene, this.camera);
    this.triangles = this.renderer.info.render.triangles;
  }

  dispose() {
    for (const [, c] of (this.world ? this.world.chunks : [])) this.removeChunk(c);
    this.sky.dispose(this.scene);
    this.renderer.dispose();
  }
}
