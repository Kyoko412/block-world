# NOTICE — 来源、许可与修改说明

本项目是 **Luanti + Mineclonia** 上的中文整合与体验定制，不是 Mojang/Microsoft 官方产品，
与二者无关联、无背书；**不包含任何 Minecraft 原版素材**。

## 上游组件

| 组件 | 版本 | 许可 | 来源 |
| --- | --- | --- | --- |
| Luanti 引擎 | 5.18.0（官方 Windows 64 位二进制，未修改） | LGPL-2.1-or-later | https://github.com/luanti-org/luanti |
| Mineclonia | 0.124.1 | GPL-3.0-or-later（逐 mod 可能双许可） | https://codeberg.org/mineclonia/mineclonia |
| Mineclonia 材质与音效 | 随游戏 | Pixel Perfection 系 CC BY-SA 4.0；其余逐文件 | 见 `games/mineclonia/LEGAL.md`、`CREDITS.md` |

引擎与游戏源码由 `luanti/scripts/fetch-deps.ps1` 按 `luanti/dependencies.lock.json` 的
版本与 SHA256 下载校验，不随本仓库分发。

## 本项目新增

| 内容 | 许可 | 位置 |
| --- | --- | --- |
| 中文菜单、默认配置、构建与冒烟脚本 | GPL-3.0-or-later | `luanti/src`、`luanti/scripts`、`luanti/tools` |
| `mc_soundpack`：移动/挖掘/破坏/放置/受伤音效 | 素材 CC0-1.0（Kenney / Peludo 录音 + 本项目加工） | `luanti/mods/mc_soundpack` |
| `mc_music`：三首原创配乐与八条提示音 | CC0-1.0（本项目原创编曲） | `luanti/mods/mc_music` |
| `mc_mobs`：蜜蜂模型、贴图与三条音效 | CC0-1.0（本项目生成） | `luanti/mods/mc_mobs` |
| HUD 几何材质包（源自 Block World CN） | CC0-1.0 | `luanti/assets` |

## 修改说明（LGPL / GPL 要求）

- 引擎**未修改**，使用官方 5.18.0 Windows 二进制。
- Mineclonia **未修改**任何 Lua 源码；所有定制通过 mod、`minetest.conf`、HUD 材质包实现。
- 若将来需要覆盖上游文件，会在 `luanti/overrides.json` 与本文件中逐条列出，并附差异补丁。
- 本项目源码以 GPL-3.0-or-later 释出（见根目录 `LICENSE`）；上游媒体保留各自许可，不被重新授权。
