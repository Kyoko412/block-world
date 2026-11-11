# 参考项目评估：E:\block world（Block World CN）

## 一、它是什么

同一个思路的先行实现：**Luanti 5.17.0 + Mineclonia 0.123.1 的中文离线单机整合**（GPL-3.0-or-later），
已经做到：中文主菜单、三档光影、HUD 替换、经验条、红石坐标修复、离线依赖锁定、启动/备份脚本、
发布包构建与检查、分层许可与 NOTICE、KNOWN_GAPS 诚实边界文档。

它的 README 自述实测：1280×720、视距 128、柔和光影约 **59 FPS**（非全地图最低帧）。

## 二、直接拿（省我们 1—2 周）

| 资产 | 位置 | 我们怎么用 |
| --- | --- | --- |
| 依赖锁定 + 校验下载 | `dependencies.lock.json`、`scripts/fetch-deps.ps1` | 改成我们的 5.18.0 / 0.124.1 + SHA256 锁定 |
| 离线自举 | `scripts/setup.ps1` | 解压运行时、按映射覆盖、建 worlds；带路径越界防护，可原样借鉴 |
| 启动与世界备份 | `scripts/launch.ps1`、`backup.ps1` | 退出后整份世界 ZIP 备份，正好补上我们"别丢存档"的空白 |
| 覆盖映射机制 | `overrides.json` | 我们用它注入自己的 mod 与配置，**尽量不改上游 Lua** |
| 中文主菜单 + 三档光影 | `src/menu.lua` | 直接作为我们的主菜单基础（柔和光影/高画质/流畅三档 + 世界列表 + 新建世界） |
| 调优配置 | `src/default.conf` | 我们 `minetest.conf` 的基线（字体、缩放、AO、雾、各向异性等一整组参数） |
| HUD 材质包 | `assets/local_classic_ui` | CC0 几何 HUD（快捷栏、选中框、经验条） |
| 经验条 mod | `src/local_experience.lua` | 40 行，直接可用 |
| 文档模板 | `docs/KNOWN_GAPS.md`、`TESTING.md`、`upstream.patch` | 我们照这个格式写"真实缺项/验收/上游差异" |
| 分层许可 | `NOTICE.md`、`licenses/` | 照抄结构：引擎 LGPL、游戏 GPL、材质 CC BY-SA、HUD CC0 |

## 三、必须改（不能照抄）

1. **版本**：它 pin 5.17.0 / 0.123.1，我们是 **5.18.0 / 0.124.1**。
   它 override 了 4 个上游文件（`inventory.lua` 267 行、`crafting_table.lua` 107 行、`redstone.lua` 675 行、若干 `.po`）。
   这些补丁在 0.124.1 上**未必能直接套用**；上游可能已修（尤其红石坐标）。
   → 策略：**先不搬上游 Lua 补丁**，逐条在 0.124.1 上复现问题；真需要再用 `overrides.json` + `upstream.patch` 记录，并注明来源。
2. **键位写法**：它用旧式 `KEY_KEY_E`（5.17 可用，5.12+ 已 deprecated）。我们 5.18 统一改成
   `SYSTEM_SCANCODE_*`（E=8、Q=20、左Ctrl=224、左Shift=225、空格=44、F2=59、F3=60、F5=62）。
3. **分辨率与目标**：它默认 1280×720；我们的 G3 目标是 **1080p ≥55 FPS**。
   它那套（体积光 + 水面反射 + 4096 阴影）在 1080p 会掉，需要重新测三档并给默认值。
4. **身份**：它只有"中文 + HUD + 光影"；**我们的差异化是声音与配乐**（80 组音效已接、三首配乐 + 8 提示音待接）。这点它没有。
5. **许可**：它整包 GPL-3.0-or-later。我们照此执行，并保留我们音频的 CC0 声明。

## 四、我们自己的目录（照它的结构，放我们的东西）

```
luanti/
├─ src/                 中文菜单、默认配置、我们自己的 Lua
├─ mods/
│  ├─ mc_soundpack/     已有：80 组 OGG + 分键位重映射
│  ├─ mc_music/         待做：三首配乐 + 8 提示音（Mineclonia 无游戏内音乐 → 独占身份）
│  ├─ mc_mobs/          待做：敌对 5 + 被动 5 的叫声替换（约 60 条）
│  └─ mc_zh/            待做：术语表与文案修正
├─ overrides.json       src → runtime 的显式映射
├─ scripts/             fetch-deps / setup / launch / backup / build-release
├─ docs/                KNOWN_GAPS / TESTING / 截图
├─ licenses/ + NOTICE   分层许可
└─ runtime/             luanti-5.18.0-win64 + games/mineclonia
```

## 五、对两周计划的影响

- D1 不再从零写菜单/配置：直接以它的 `menu.lua` + `default.conf` 为基线，改成 1080p 与 5.18 键位。
- D1 加一项：逐条验证它的上游补丁在 0.124.1 上是否仍需要（红石坐标、背包布局、工作台 UI）。
- D2 的 G3 测量目标更明确：把它的"720p/59FPS"当作基线参照，量我们在 1080p 的差距，决定默认档。
- D3—D5 不变：音乐 + 生物叫声进 Luanti。

## 六、已落地

`游戏/方块世界-Luanti/minetest.conf` 已按它的调优参数重写，并改成 5.18 的 `SYSTEM_SCANCODE_*`
（1080p 默认 + 三档注释备选）。下一步是把 `menu.lua` 接进我们的包。
