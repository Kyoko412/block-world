'use strict';
/*
 * 天空盒：跟随相机的球壳 + 着色器（渐变天空、日出日落、太阳/月亮、星空）。
 * 同时给外部提供当前雾色与日照强度，用于方块着色器与雾效。
 */
import * as THREE from '../../vendor/three.module.js';

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  /* 球壳半径必须大于地形远平面；把深度钉到远平面，避免调整视距时整片天空被裁掉。 */
  gl_Position.z = gl_Position.w;
}`;

const FRAG = `
precision mediump float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uTime;
uniform float uUnderwater;
uniform float uCloud;        // 0~1：降水强度（0=晴，1=大雨/大雪）
uniform vec3 uCloudTint;     // 云层基色（雨偏青灰、雪偏亮灰）
uniform vec3 uCamPos;        // 方块云的水平位置与高度参考

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 dir = normalize(vDir);
  float up = clamp(dir.y, -1.0, 1.0);
  float sunH = uSunDir.y;
  float day = smoothstep(-0.20, 0.22, sunH);
  float sunset = pow(max(0.0, 1.0 - abs(sunH) * 2.6), 2.2);

  vec3 nightZenith = vec3(0.016, 0.024, 0.075);
  vec3 nightHorizon = vec3(0.045, 0.062, 0.125);
  vec3 dayZenith = vec3(0.30, 0.55, 0.92);
  vec3 dayHorizon = vec3(0.62, 0.80, 0.98);
  vec3 sunsetHorizon = vec3(0.98, 0.52, 0.24);

  vec3 zenith = mix(nightZenith, dayZenith, day);
  vec3 horizon = mix(nightHorizon, dayHorizon, day) + sunsetHorizon * sunset * 0.75;

  float t = pow(max(up, 0.0), 0.42);
  vec3 col = mix(horizon, zenith, t);
  // 地平线以下（从高处往下看时）稍微压暗
  col *= 1.0 - smoothstep(0.0, -0.35, up) * 0.35;

  // 天气：阴天看不见日月星，天空整体压向云层色
  float clear = 1.0 - clamp(uCloud, 0.0, 1.0);

  // 方块太阳：在日面切平面上量角度，而不是画一个圆形光碟。
  float sd = dot(dir, uSunDir);
  vec3 sunTx = normalize(cross(vec3(0.0, 1.0, 0.0), uSunDir));
  vec3 sunTy = normalize(cross(uSunDir, sunTx));
  vec2 sunUv = vec2(dot(dir, sunTx), dot(dir, sunTy)) / max(sd, 0.001);
  float sunSquare = step(0.997, sd) * step(max(abs(sunUv.x), abs(sunUv.y)), 0.052);
  float glow = pow(max(sd, 0.0), 90.0) * 0.16 + pow(max(sd, 0.0), 12.0) * 0.07;
  vec3 sunCol = mix(vec3(1.0, 0.64, 0.30), vec3(1.0, 0.96, 0.72), day);
  col = mix(col, sunCol * (1.0 + sunset * 0.18), sunSquare * clear);
  col += sunCol * glow * (0.35 + sunset * 0.65) * clear;

  // 方块月亮：8×8 的少量暗斑，夜里仍保持硬边像素轮廓。
  float md = dot(dir, uMoonDir);
  vec3 moonTx = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
  vec3 moonTy = normalize(cross(uMoonDir, moonTx));
  vec2 moonUv = vec2(dot(dir, moonTx), dot(dir, moonTy)) / max(md, 0.001);
  float moonSquare = step(0.997, md) * step(max(abs(moonUv.x), abs(moonUv.y)), 0.043);
  vec2 moonPixel = floor((moonUv / 0.043 * 0.5 + 0.5) * 8.0);
  float moonShade = 0.82 + 0.18 * step(0.28, hash21(moonPixel + 7.0));
  vec3 moonCol = vec3(0.86, 0.89, 0.93) * moonShade;
  col = mix(col, moonCol, moonSquare * (1.0 - day) * clear);

  // 星空
  if (day < 0.75) {
    vec3 g = dir * 90.0;
    vec2 cell = floor(g.xy + g.z * 1.7);
    float star = hash21(cell);
    float bright = smoothstep(0.9955, 1.0, star);
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.1 + star * 63.0);
    col += vec3(0.95, 0.97, 1.0) * bright * twinkle * (1.0 - day) * max(up, 0.0) * clear;
  }

  // 晴天方块云：在世界高度的平面上采样粗网格，云随时间缓慢漂移。
  // 只改变天空，不参与碰撞、遮蔽判定或存档，雷雨天则融入原有阴雨层。
  if (dir.y > 0.025 && uCamPos.y < 88.0) {
    float cloudDistance = (88.0 - uCamPos.y) / dir.y;
    vec2 cloudPos = uCamPos.xz + dir.xz * cloudDistance + vec2(uTime * 0.75, uTime * 0.16);
    vec2 cloudCell = floor(cloudPos / 15.0);
    float cloudSeed = hash21(cloudCell);
    float cloudShape = step(0.86, cloudSeed);
    // 少量云在相邻方向延伸一格，避免所有云都是孤立同尺寸方块。
    cloudShape = max(cloudShape, step(0.94, hash21(cloudCell + vec2(1.0, 0.0))) * 0.85);
    float horizonFade = smoothstep(0.035, 0.16, dir.y) * (1.0 - smoothstep(180.0, 420.0, cloudDistance));
    float cloudAlpha = cloudShape * horizonFade * mix(0.40, 0.66, day) * (1.0 - uCloud * 0.72);
    vec3 fairCloud = mix(vec3(0.025, 0.035, 0.070), vec3(0.88, 0.91, 0.94), day);
    fairCloud *= 0.94 + 0.06 * step(0.5, fract(cloudSeed * 7.0));
    col = mix(col, fairCloud, cloudAlpha);
  }

  // 云层色：白天偏灰蓝、夜里仍要保持一定的暗度，不能把夜空提亮
  vec3 cloudCol = uCloudTint * (0.22 + 0.78 * day);
  col = mix(col, cloudCol, clamp(uCloud, 0.0, 1.0) * 0.80);

  // 水下整体偏蓝绿压暗
  col = mix(col, vec3(0.05, 0.18, 0.35), uUnderwater * 0.8);
  gl_FragColor = vec4(col, 1.0);
}`;

export class SkyDome {
  constructor(scene, radius = 500) {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.4, 0.9, 0.2) },
      uMoonDir: { value: new THREE.Vector3(-0.4, -0.9, -0.2) },
      uTime: { value: 0 },
      uUnderwater: { value: 0 },
      uCloud: { value: 0 },
      uCloudTint: { value: new THREE.Color(0.42, 0.47, 0.53) },
      uCamPos: { value: new THREE.Vector3() }
    };
    const geo = new THREE.SphereGeometry(radius, 32, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.fogColor = new THREE.Color(0x8ac4ff);
    this.dayFactor = 1;
    this.sunDir = new THREE.Vector3();
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /* timeOfDay: 0~1（0=日出，0.25=正午，0.5=日落，0.75=午夜）
     weather: {type:'clear'|'rain'|'snow', intensity:0~1}，可省略（视为晴天） */
  update(timeOfDay, elapsed, cameraPos, underwater, weather) {
    const wt = (weather && weather.type) || 'clear';
    const wi = Math.max(0, Math.min(1, (weather && weather.intensity) || 0));
    const storm = !!(weather && weather.storm && wt === 'rain');
    const ang = timeOfDay * Math.PI * 2;
    const sun = this.sunDir.set(Math.cos(ang) * 0.55, Math.sin(ang), Math.cos(ang) * 0.4 + 0.25).normalize();
    this.uniforms.uSunDir.value.copy(sun);
    this.uniforms.uMoonDir.value.set(-sun.x, -sun.y, -sun.z);
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uUnderwater.value = underwater ? 1 : 0;
    this.uniforms.uCloud.value = wt === 'clear' ? 0 : wi;
    this.uniforms.uCamPos.value.copy(cameraPos);
    // 雨：青灰；雪：偏亮的灰白；雷暴：更暗的铅灰
    if (wt === 'snow') this.uniforms.uCloudTint.value.setRGB(0.72, 0.75, 0.80);
    else if (storm) this.uniforms.uCloudTint.value.setRGB(0.24, 0.28, 0.34);
    else this.uniforms.uCloudTint.value.setRGB(0.40, 0.46, 0.54);
    this.mesh.position.copy(cameraPos);

    const day = smoothstep(-0.20, 0.22, sun.y);
    this.dayFactor = day;
    const sunset = Math.pow(Math.max(0, 1 - Math.abs(sun.y) * 2.6), 2.2);
    /* 雾色 = 与着色器同一套地平面色，但要**再往天顶方向偏一点**并轻微去饱和。
       旧写法直接用 horizon（0.62,0.80,0.98）当雾色：一块饱和的浅蓝。
       远景地形整片淡进这种颜色，就会读成「浅蓝剪影」——
       它比天空略亮、又比地形亮得多，视觉上像贴了一层蓝纸。
       现在把雾色往 zenith 混 22%，再向中性灰靠 10%：
       远处是「大气里的冷灰蓝」，边缘不再比天空更亮。 */
    const night = [0.045, 0.062, 0.125], d = [0.62, 0.80, 0.98], su = [0.98, 0.52, 0.24];
    const dayZenith = [0.30, 0.55, 0.92], nightZenith = [0.016, 0.024, 0.075];
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const horizon = night[i] + (d[i] - night[i]) * day + su[i] * sunset * 0.55;
      const zenith = nightZenith[i] + (dayZenith[i] - nightZenith[i]) * day;
      let v = horizon + (zenith - horizon) * 0.22;
      const grey = (v + v + v) / 3;
      v = v + (grey - v) * 0.10;
      out[i] = Math.max(0, Math.min(1, v));
    }
    // 降水时雾色也压向云层色（雪天更亮、雨天更暗、雷暴最暗）
    if (wt !== 'clear') {
      const tint = wt === 'snow' ? [0.72, 0.75, 0.80] : (storm ? [0.22, 0.26, 0.32] : [0.40, 0.46, 0.54]);
      for (let i = 0; i < 3; i++) out[i] = out[i] + (tint[i] * (0.22 + 0.78 * day) - out[i]) * wi * 0.8;
    }
    if (underwater) for (let i = 0; i < 3; i++) out[i] = out[i] * 0.2 + [0.05, 0.18, 0.35][i] * 0.8;
    this.fogColor.setRGB(out[0], out[1], out[2], THREE.SRGBColorSpace);
    return { dayFactor: day, sunDir: sun, sunset, weatherType: wt, weatherIntensity: wi };
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export { smoothstep };
