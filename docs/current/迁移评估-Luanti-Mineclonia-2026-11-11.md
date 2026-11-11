# Luanti + Mineclonia 迁移评估（2026-11-11 实测）

结论先说：**可行，而且这是目前唯一能在"内容量"上追平 Minecraft 的路线**。但它是换掉引擎，不是给现有项目打补丁——五包音频的"素材"能全部复用，"引擎层"要重写；另外许可从"我们自己的 CC0"变成 **LGPL-2.1+ / GPLv3 / CC BY-SA** 三层约束。

本文所有数字都来自本机实测，不是估计。

---

## 一、实测结果（本轮已做）

已在 `游戏\方块世界-Luanti\` 组装出一个便携包：

| 项 | 实测结果 |
| --- | --- |
| 引擎 | **Luanti 5.18.0**（Windows 64 位便携版，官方 GitHub Release），LuaJIT 2.1 |
| 游戏 | **Mineclonia 0.124.1**（Codeberg main 分支源码），放进 `games/mineclonia/` |
| 体积 | 解压后 **117 MB**（比现有 Electron 包 290 MB 更小） |
| 启动方式 | `bin/luanti.exe`，便携版自动读上一级 `minetest.conf` |
| 冒烟测试 | `luanti.exe --server --gameid mineclonia` 跑 90 秒：世界创建成功、`mcl_villages` / `mcl_levelgen`（要塞选点）等模组正常初始化、端口监听正常 |
| 中文（引擎） | 便携包内 `locale/zh_CN/LC_MESSAGES` 已存在 |
| 中文（游戏） | **139 个模组带 zh_CN 翻译，4081 条词条里 4032 条已翻，覆盖率 98.8%**，仅 49 条为空 |
| 中文字体 | 引擎自带 `fonts/DroidSansFallbackFull.ttf`（CJK 回退），配置项 `fallback_font_path` 默认就指向它，不依赖系统装字体 |
| 光影相关设置 | `minetest.conf.example` 里确认存在：`enable_dynamic_shadows`、`shadow_map_max_distance`、`shadow_map_texture_size`、`shadow_soft_radius`、`enable_post_processing`、`enable_auto_exposure`/`exposure_compensation`、`enable_bloom`、`debanding`、`anisotropic_filter`、`enable_waving_leaves`/`plants`/`water`、`enable_water_reflections`、`enable_translucent_foliage`、`enable_volumetric_lighting`、`enable_ssao`、`viewing_range` |
| 声音格式 | **只支持 Ogg Vorbis**；定位播放必须是**单声道**；同名文件 `<name>.ogg` / `<name>.0.ogg`…`9.ogg` 构成"声音组"，播放时**引擎自动随机挑一个** |
| 引擎内置特殊声音组 | `player_damage`、`player_falling_damage`、`player_jump`、`default_dig_<groupname>` —— 这几类**不需要写任何 Lua**，丢文件进去就生效 |

已写好的配置文件：`游戏/方块世界-Luanti/minetest.conf`（`language = zh_CN`、CJK 回退字体、均衡档光影 + 性能/高画质两套注释备选）。

> 清理说明：冒烟测试产生的 `worlds/world`、`cache/`、`debug.txt` 已删除，包内不留测试世界。

---

## 二、能补上多少内容（对照上一份缺口报告）

| 缺口类别 | 自研现状 | Mineclonia 提供 | 结论 |
| --- | --- | --- | --- |
| 生物群系 | 8 | **68**（自定义 mapgen：58 主世界 + 5 下界 + 5 末地） | 直接补齐 |
| 维度 | 只有主世界 | 主世界 + **下界** + **末地**（含传送门） | 直接补齐 |
| 生物 | 14 | "大多数怪物与动物"（含僵尸变种、苦力怕、骷髅、蜘蛛、史莱姆、末影人、猪灵、疣猪兽、劫掠兽等） | 大幅补齐 |
| 矿物与方块 | 77 方块 | 主世界绝大多数方块、全部矿物、下界/末地方块、楼梯/半砖/门/活板门/栅栏/墙全套 | 大幅补齐 |
| 经验与附魔 | 无 | **有**（经验、附魔台、附魔） | 直接补齐 |
| 酿造与药水 | 无 | **部分**（酿造台、药水、药箭，README 自述 partial） | 基本补齐 |
| 红石 | 无 | **部分**（红石电路，自述 partial） | 补一半 |
| 船 / 矿车 | 无 | **有**（矿车 partial） | 直接补齐 |
| 村庄 / 结构 | 自研村庄+营地+地标 | 村庄、要塞、下界要塞、海底神殿、林地府邸等（Luanti <5.14 用替代结构） | 直接补齐 |
| 合成配方 | 77 + 17 | 上千条 + 内置合成指南 | 直接补齐 |
| 中文界面 | 自研全中文 | **98.8% 已翻译**（仅 49 条空） | 只剩润色 |
| 我们的五包音频 | 128 条 WAV / 3.2 MB | 引擎声音系统（OGG、声音组、定位） | **素材复用，触发重写** |
| 我们的自有玩法 | 守卫 Boss、任务、成就、地标、营地 | 无（要写成 mod） | 需要移植或放弃 |

一句话：**内容这一块的 90% 一次补齐，剩下的是"我们的声音"和"我们的玩法"。**

---

## 三、许可：这是最硬的一层约束

| 组件 | 许可 | 对我们的要求 |
| --- | --- | --- |
| Luanti 引擎 | **LGPL-2.1+** | 分发时必须提供源码（未改可指向官方仓库）；改了引擎必须提供改动后的源码并在程序内声明改动；保留版权声明 |
| Mineclonia 游戏代码 | **GPLv3**（或 GPLv3+，逐 mod 可能双许可） | 分发修改版必须以 GPLv3 提供完整源码；我们的 mod 若与其一起分发，要 GPLv3 兼容 |
| Mineclonia 媒体 | **CC BY-SA 4.0**（Pixel Perfection 材质等，逐 mod 可能 CC0/CC BY） | 署名 + 相同方式共享；我们替换/混入的素材要遵守 |
| 我们已有的音频 | CC0（自合成/CC0 录音） | 可以并入，保留授权说明即可（CC0 与上述均兼容） |

**直接后果**：这套东西一旦对外分发，"闭源 + 只发二进制"这条路就没了。如果是自用/开源发布，完全没问题；如果要做商业发行，需要法务评估（LGPL 动态链接、GPL 传染范围）。

---

## 四、音频迁移：比想象中便宜，但触发要重写

### 能白拿的（零 Lua）

- `player_damage.ogg`、`player_falling_damage.ogg`、`player_jump.ogg` → 我们的 `hurt_body` / `hurt_fall` / `jump` 直接改名丢进去。
- `default_dig_<group>.ogg` → 挖掘音。
- 方块脚步声/挖掘声：Mineclonia 的节点声音走 `mcl_sounds.node_sound_*` 表，把表项指向我们的声音组即可（改的是数据，不是逻辑）。

### 必须写 Lua 的

- 战斗命中/护甲/盾牌（Mineclonia 自己的战斗回调）。
- 进食（Mineclonia 的 `mcl_hunger`，我们的"咬—嚼—吞"过程要重新挂）。
- 环境声、配乐（第 4/5 包）。

### 变体与格式

我们的 `dig_stone` / `dig_stone_b` / `dig_stone_c` / `dig_stone_d` 四条录音，正好对应 Luanti 的**声音组**：`dig_stone.ogg`、`dig_stone.0.ogg`、`dig_stone.1.ogg`、`dig_stone.2.ogg` —— 引擎自己随机选，**不需要我们写轮换代码**（现有 Electron 版本里的变体轮换逻辑可以整段丢掉）。

代价：**全部转成 OGG（单声道）**。本机没有 ffmpeg，需要一个静态 ffmpeg 或 `npm i @ffmpeg-installer/ffmpeg`（约 80 MB 一次性）。

---

## 五、三条路线

| 路线 | 做什么 | 工期 | 代价 |
| --- | --- | --- | --- |
| **A. 纯发行版** | Luanti + Mineclonia + 中文 + 光影配置，原样发布 | 1–2 周 | 与我们的五包音频、守卫、任务完全无关；只是"中文 Mineclonia" |
| **B. 发行版 + 我们的 mod（推荐）** | A + 音频包 mod（五包逐包接）+ 界面/光影 + 后续玩法 mod | 4–6 周出可玩版 | 要写 Lua、要处理 GPLv3、观感与我们原设计不同 |
| **C. 继续自研** | 在 Electron 项目里补 59 群系 / 72 生物 | 数月到一年 | 内容永远追不上，但完全自主 |

推荐 **B**：既拿到内容，又保住我们花了两轮打磨的声音设计（那 128 条素材是我们真正的差异化）。

---

## 六、B 路线的分阶段计划

### P0 垂直切片（1–2 天，先证明三件事同时成立）

1. 装 ffmpeg → 把**石头/泥土/木头/沙**的挖与放 8 条 WAV 转 OGG（单声道）。
2. 写 `mods/mc_soundpack/`：`init.lua` 里把 `mcl_sounds` 的对应表项指向我们的声音组，并放 `player_damage` / `player_falling_damage` / `player_jump`。
3. 启动客户端，进世界截图：中文是否正常、阴影/后处理是否生效、挖石头是不是我们的音色。

三条都成立，才值得往下做；任何一条不成立，先解决它。

### P1 音频全量迁移（3–5 天）

- 128 条 WAV → OGG（保留"干、短、lo-fi"的既定风格）。
- 移动包：`mcl_sounds` 脚步表 + 材质分组（草/石/木/沙/雪）。
- 挖放包：`default_dig_*` + 破坏/放置。
- 战斗包：命中/受伤/护甲/盾/弓 + `player_damage`。
- 进食包：重写"咬—嚼—吞"的 Lua 过程（Mineclonia 进食是即时生效，这一条要自己实现）。

### P2 界面与光影（2–3 天）

- 中文：补 49 条空词条 + 术语统一（"泥土/土块"这类要统一），我们的 mod 自带 `.po`。
- 光影：`minetest.conf` 三档（性能/均衡/高画质）实测帧率后定默认；字体大小、GUI 缩放按 1080p/720p 校准。
- 键位：把 Luanti 默认的 I（背包）、Aux1（疾跑）改成 MC 习惯（E / Ctrl），写进默认配置。

### P3 自有玩法（可选，10–20 天）

守卫 Boss、任务链、成就、地标、营地——以 mod 形式重写。也可以明确放弃，只保留"中文 + 我们的声音 + 更好的光影"。

---

## 七、风险清单

1. **GPLv3 传染**：一旦分发，整套（含我们的 mod）都要以 GPLv3 提供源码。
2. **观感差异**：Mineclonia 用 Pixel Perfection 16px 材质与另一套音效，不是我们原来那套"自然温暖"的观感；我们只能替换声音，材质要换就得自己做整包贴图。
3. **上游 beta**：README 自述 beta，不保证跨版本存档兼容；我们若跟着升级，要做存档迁移测试。
4. **性能**：动态阴影 + 体积光在中低配可能掉帧；需要三档配置 + 实测。
5. **存档不可迁移**：现有 Electron 版的 JSON 存档无法导入，玩家要从新世界开始。
6. **手机/触屏**：Luanti 支持 Android，但我们的目标是 PC，先不管。

---

## 八、下一步（按顺序，可直接开工）

1. 装 ffmpeg（静态包或 npm），写一个 `tools/audio-ogg.mjs`：把 `app/renderer/media/sfx/*.wav` 批量转单声道 OGG，并按"声音组"命名。
2. 写 `mods/mc_soundpack/`：先接 8 条挖/放，验证声音组随机与定位。
3. 客户端实机截图 + 录音，确认中文/光影/音色三件事，再决定 P1 全量迁移。

> 本轮只做了"组装 + 冒烟 + 配置 + 评估"，没有改动现有 Electron 项目的任何代码、存档或已交付的四个试玩包。
