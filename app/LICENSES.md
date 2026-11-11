# 开源许可声明（LICENSES）

《方块世界》是一个完全离线运行的中文 3D 体素沙盒游戏。游戏本体（世界生成、渲染逻辑、界面、
程序化材质与音效）为本项目原创代码；运行时依赖下列第三方开源项目，按其许可证随包分发。

---

## 1. three.js —— 3D 渲染引擎

- 版本：r169（0.169.0）
- 许可证：MIT License
- 用途：WebGL 渲染（区块网格、天空盒、粒子、手持物品）
- 代码位置：`resources/app/renderer/vendor/three.module.js`
- 项目主页：https://threejs.org/

```
The MIT License

Copyright © 2010-2024 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 2. Electron —— 桌面运行时（提供 方块世界.exe）

- 版本：33.4.11
- 许可证：MIT License
- 用途：把游戏打包成免安装的 Windows 可执行程序
- 完整许可文本见同目录 `LICENSE` 与 `LICENSES.chromium.html`
  （Electron 内嵌 Chromium、Node.js、V8 以及数十个第三方组件，其许可证全部包含在
  `LICENSES.chromium.html` 中，请用浏览器打开查看。）

```
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 3. 字体与游戏音频

- 界面字体使用系统字体回退链，不随包分发字体。方块材质、图标由本项目代码绘制。
- 移动、挖放、战斗与受伤、进食、环境声采用下文逐组登记的 CC0 真实录音。少数尚未替换的生物叫声和旧事件，以及文件缺失时的备用配方，仍由 Web Audio 合成。
- 正式配乐现为本项目用 Strudel 编排的三首原创作品：白天《林径初光》（约 81 秒）、夜晚《星下归途》（约 96 秒）、洞穴《石间微光》（约 87 秒）。完整乐谱在 app/tools/music-audio/score.mjs；旧外部三曲已从正式资源中替换。
- 八个原创提示音用于点击、打开/关闭界面、拾取、制作、成就/进展、守卫苏醒与守卫完成，均由同一乐器音色家族制作。
- 乐器录音为 VSCO 2 Community Edition，录音作者 Versilian Studios / Sam Gossner；立式钢琴为 Ivy Audio / Simon Dalzell。原仓库以 CC0 1.0 Universal 发布，许可全文随包附于 VSCO-CC0.txt。
  来源：https://github.com/sgossner/VSCO-2-CE/tree/SFZ
  许可：https://github.com/sgossner/VSCO-2-CE/blob/SFZ/LICENSE
  钢琴来源说明：https://github.com/sgossner/VSCO-2-CE/blob/SFZ/Keys/Upright%20Piano/Info.txt
- 使用 13 个固定版本的钢琴、竖琴和马林巴录音，按原 SFZ 的 pitch_keycenter 映射音高。制作时以 Strudel core 1.2.6 / superdough 1.3.0 采样、变速定音、滤波、声像、力度和包络演奏原创乐谱；保留原录音的自然共鸣，做淡入淡出、RMS 校准和峰值限制，导出 44.1kHz 16bit PCM WAV。编曲及新提示音按项目音频清单以 CC0-1.0 记录。
- 原录音的固定提交、原始 URL、字节指纹和音高中心在 app/tools/music-audio/recordings.mjs；三首作品与提示音的乐谱指纹、采样来源和导出指纹在 renderer/js/core/musicfiles.js 与 notifyfiles.js。制作端遵循 Terma 的 Strudel 专项指南：https://github.com/bfollington/terma/blob/main/plugins/tsal/skills/strudel/SKILL.md
- Strudel 仅为制作端工具；游戏包不含 Strudel 引擎或其依赖。运行时配乐、音效、环境声均经本地回环服务读取随包文件，不从外部网站取音频。

- 本项目是受《Minecraft》视觉风格启发的原创实现，与 Mojang / Microsoft 无关，未使用《Minecraft》的代码、材质、模型、音乐或商标资源。“Minecraft” 为 Mojang Synergies AB 的商标。

## 4. 本项目自有代码

除上述第三方组件外，本项目代码采用 MIT License：

```
MIT License

Copyright (c) 2026 方块世界（本项目）

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 移动音效录音与制作

- 草土、石、木、雪脚步及身体离地接触：Kenney，Impact Sounds 1.0，CC0-1.0。原始文件使用 footstep_grass、footstep_concrete、footstep_wood、footstep_snow 各 000—003，以及 footstep_carpet_000。
  原始发布页：https://kenney.nl/assets/impact-sounds
- 沙砾接触：Peludo，Water Splash and sand footsteps，CC0-1.0。使用 sand_footsteps_0.mp3 中四个不同接触片段。
  原始发布页：https://opengameart.org/content/water-splash-and-sand-footsteps
- 加工：使用 Strudel core 1.2.6 / superdough 1.3.0 进行采样、滤波和速率处理，再裁切、短淡出与响度校准，导出 44.1kHz 单声道 16bit WAV。每条音频的来源、切片范围、加工参数及指纹记在随源码提供的移动音频登记表中。
- Strudel 为制作端工具，采用 Terma 的 Strudel 专项指南；游戏包包含导出的 CC0 音频，不包含 Strudel 引擎或其依赖。
  专项指南：https://github.com/bfollington/terma/blob/main/plugins/tsal/skills/strudel/SKILL.md
  Strudel：https://codeberg.org/uzu/strudel

## 挖掘与放置音效录音与制作

- 撞击瞬态：Kenney，Impact Sounds 1.0，CC0-1.0。
  原始发布页：https://kenney.nl/assets/impact-sounds
  作者页：https://kenney.nl
- 沙、砂砾与干叶的颗粒层：Peludo，Water Splash and sand footsteps，CC0-1.0。取 sand_footsteps_0.mp3 中 4 段独立摩擦颗粒，按层错开 0—30ms 叠放，做「沙沙」与干叶碎响。
  原始发布页：https://opengameart.org/content/water-splash-and-sand-footsteps
- 实际使用的原始文件（每条导出只引用其中一条或数条不同录音，变体之间不共用同一条样本）：
  impactSoft_medium、impactSoft_heavy、impactMining、impactWood_light、impactWood_medium、impactPlank_medium、impactGeneric_light、impactPlate_light，各 000—004；sand_footsteps_0.mp3 的 4 段颗粒。
- 加工：Strudel core 1.2.6 / superdough 1.3.0 做滤波、速率与叠层（破坏声在同一变体内叠两层不同录音），再裁切到动作长度、12ms 淡入 / 25ms 淡出、按短窗 RMS 校准力度并限制峰值，导出 44.1kHz 单声道 16bit WAV。
- 许可与来源逐条登记在源码中的 `app/renderer/js/core/digfiles.js`（作者、原始文件、字节数、SHA-256、加工说明），单元检查会对照磁盘文件核对；本项目的许可允许清单只收 CC0-1.0。
- 制作端脚本在 `app/tools/interaction-audio/`；游戏包只包含导出的 WAV，不含 Strudel 引擎。

## 战斗与受伤音效录音与制作

- 2026-11-11 自然录音修订：共 26 条挥击、命中、受伤、盾甲、弓箭与死亡衣料反馈，全部使用 CC0-1.0 真实录音，不再使用本项目合成层。
- Kenney，Impact Sounds 1.0，身体接触、木与金属撞击拟音。
  原始发布页：https://kenney.nl/assets/impact-sounds
  作者页：https://kenney.nl
- Wareya，RPG Foley，使用 `foley - swishes.wav`、`foley - clothes.wav`、`foley - metal clank.wav`、`foley - chain a.wav` 的不同片段。作者说明全部是在真实环境录制的拟音。
  原始发布及许可：https://warsong.pages.dev/tags/sounds/
- unfa，Short Male Pain Grunts，取较轻的短人声片段用于身体受击和摔伤。使用作者公开 HQ MP3 试听，不是原始 FLAC；仅作离线剪辑、滤波与游戏播放。
  原始发布及 CC0 许可：https://freesound.org/people/unfa/sounds/610991/
- Ali_6868，Bow Release (Bow and Arrow) 1/2 与 Arrow Impact 1/2，大学项目中实际录制的弓释放和箭命中。使用作者公开 HQ MP3 试听，不是原始 WAV。
  原始发布及 CC0 许可：https://freesound.org/people/Ali_6868/sounds/384915/ 、https://freesound.org/people/Ali_6868/sounds/384916/ 、https://freesound.org/people/Ali_6868/sounds/384914/ 、https://freesound.org/people/Ali_6868/sounds/384913/
- felix.blume，Underwater recording of aquatic movement, bubbles and drops.，真实水听器录音。只取公开 HQ MP3 前 262144 字节（解码约 10.68 秒）中的两段水下气泡，专用于实际溺水伤害，不使用整段作为环境床。
  原始发布及 CC0 许可：https://freesound.org/people/felix.blume/sounds/384218/
- 加工：Strudel core 1.2.6 / superdough 1.3.0 负责采样、温和滤波与短叠层；去直流、裁切、3/8ms 淡入、30ms 淡出、整段 RMS 校准与峰值限制，导出 44.1kHz 单声道 16bit WAV。无合成湿挤压、振荡器、钢鸣层、位深破坏、变调或混响。
- 摔伤只有真实短人声，不加第二次落地撞击；死亡反馈是轻衣料落定，不重复人声。许可、每一层原始录音的作者/原页/SHA-256/切片范围，以及导出指纹逐条登记在 `app/renderer/js/core/combatfiles.js`。
- 制作端脚本在 `app/tools/combat-audio/`；游戏包只包含导出的 WAV，不含 Strudel 引擎。

## 进食音效：真实录音重制（2026-11-11）

- Wareya，RPG Foley，CC0-1.0。作者说明全部为真实环境下录制的拟音。使用 `foley - munch.wav` 的不同接触片段，以及 `foley - swallow.wav`、`foley - quaff.wav` 的吞咽片段。
  作者与原始发布页：https://warsong.pages.dev/tags/sounds/
  原始下载：https://warsong.pages.dev/sounds/rpg%20foley.zip
- thedapperdan，Biting an Apple，CC0-1.0。真实近距离苹果咬嚼录音。使用作者公开的高质量 MP3 试听版本，不是登录下载的原始 WAV。
  作者与许可页：https://freesound.org/people/thedapperdan/sounds/199923/
  公开音频：https://cdn.freesound.org/previews/199/199923_11337-hq.mp3
- 共 17 条：干粮、果蔬、柔软熟食各三条咬与两条嚼，共用两条吞。不同变体选取不同原始接触片段，未叠加合成碎裂、湿挤压或卡通吞咽层。
- 加工：Strudel core 1.2.6 / superdough 1.3.0 采样与温和滤波；去直流、裁切、短淡入淡出、整段 RMS 校准与峰值限制，导出 44.1kHz 单声道 16bit WAV。未使用位深破坏、降采样保持、混响或改音高。
- `app/renderer/js/core/eatfiles.js` 逐条记录作者、许可、原始文件、原录音 SHA-256、切片时间范围、加工参数和导出指纹。制作参数与可复现导出脚本在 `app/tools/eat-audio/`，首次导出缺少原录音时会下载并校验；游戏运行完全离线。

## 环境声：真实野外录音（2026-11-11）

- 五条长循环使用下列 CC0-1.0 真实录音，均来自作者公开的 HQ MP3 试听版本，不是登录下载的原始 WAV。
- kvgarlic：Quiet winter woods wind Dec 18 2024（树叶风）、Spring Overnight crickets MAY 30 2025（夜间虫鸣）、AutumnRainWithTingNov2011.wav（柔和秋雨）。三条分别只取 HQ MP3 开头 1048576 字节，解码约 44—46 秒，裁选其中 34 秒输入制作 32 秒循环。
  原始发布及许可：https://freesound.org/people/kvgarlic/sounds/781681/ 、https://freesound.org/people/kvgarlic/sounds/810306/ 、https://freesound.org/people/kvgarlic/sounds/136540/
- naturenotesuk：Robin singing，实录欧亚鸲，两段不同鸟句轻混于白天林地，句间留白。
  原始发布及许可：https://freesound.org/people/naturenotesuk/sounds/418425/
- mentos987：cave dripping water，小洞穴入口的实录空气与滴水，取其中 26 秒制作 24 秒循环。
  原始发布及许可：https://freesound.org/people/mentos987/sounds/818888/
- felix.blume：Underwater recording of aquatic movement, bubbles and drops.，真实水听器录音。使用公开 HQ MP3 开头 262144 字节中的 10 秒，制作 8 秒水下循环。
  原始发布及许可：https://freesound.org/people/felix.blume/sounds/384218/
- 加工：Strudel core 1.2.6 / superdough 1.3.0 制作端采样、温和高/低通；去直流、保留立体声场（原单声道不伪造空间延迟）、2 秒等功率首尾交叉混合并旋转循环起点、RMS 校准及峰值限制，导出 44.1kHz 立体声 16bit WAV。不变调、不添加振荡器、合成虫鸣/滴水或噪声床。
- 每一层录音的作者、原页、原录音 SHA-256、切片范围，以及每条导出的指纹记在 `app/renderer/js/core/ambientfiles.js`；制作清单与工具在 `app/tools/ambient-audio/`。运行期间只读取本地随包音频。



