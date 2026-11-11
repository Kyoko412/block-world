# 方块世界（Block World CN）

一个中文离线单机方块游戏：

| 版本 | 位置 | 状态 |
| --- | --- | --- |
| **新版（Luanti + Mineclonia）** | `luanti/` + `游戏/方块世界-Luanti/` | 开发中：底座已通，内容来自 Mineclonia，体验层在补 |

> 旧的 Electron 版本（1.1.0，含源码与历史取证）已移出本仓库，归档在 `E:\MinecraftOffline Demo`，只作归档、不再开发。

新版不是重写引擎：**Luanti 提供引擎、Mineclonia 提供内容，我们只做体验层**（中文、声音、光影、生物补全、世界感、目标感）。

## 快速开始

```
启动游戏.bat        # 新版（Luanti）
```

新版进入后选世界 `mcsound`（已启用音效包 / 配乐 / 蜜蜂原型）。

## 目录

```
luanti/                 新版的"我们这一层"
├─ src/                 中文菜单、默认配置
├─ mods/                mc_soundpack（音效组）· mc_music（配乐与提示音）· mc_mobs（生物补全）
├─ assets/              CC0 几何 HUD
├─ scripts/             fetch-deps / setup / smoke / screenshot / backup
├─ tools/               WAV→OGG、素材生成
├─ dependencies.lock.json  Luanti 5.18.0 + Mineclonia 0.124.1（含 SHA256）
└─ overrides.json       src → 运行时目录的显式映射

游戏/                   本地产物（不入库）：两个可运行版本
artifacts/              本地取证（不入库）
```

## 构建与验证（新版）

```powershell
# 1) 下载并校验依赖（首次）
powershell -NoProfile -ExecutionPolicy Bypass -File luanti/scripts/fetch-deps.ps1

# 2) 从 downloads/ 组装可运行目录
powershell -NoProfile -ExecutionPolicy Bypass -File luanti/scripts/setup.ps1 -Target "游戏\方块世界-Luanti"

# 3) 冒烟测试（注册表断言）
bash luanti/scripts/smoke.sh "游戏/方块世界-Luanti"
```

`smoke.sh` 会起一个临时世界并断言：节点数 ≥3000、实体数 ≥291、`mc_mobs:bee` 已注册、音效与配乐文件存在。

## 许可

- 引擎 **Luanti 5.18.0**：LGPL-2.1-or-later（未修改，使用官方二进制）。
- 游戏 **Mineclonia 0.124.1**：GPL-3.0-or-later；材质多为 CC BY-SA 4.0。
- 本项目新增（mods、脚本、HUD、贴图、配乐）：GPL-3.0-or-later / 素材 CC0-1.0。
- 详见运行目录内 `NOTICE.md` 与各 mod 的 `LICENSE` 声明；**不包含任何 Minecraft 原版素材**。

## 路线（摘要）

1. 底座：中文、1080p、我们的音效与配乐、可复现构建 ✅（部分）
2. 音效接线：战斗 / 进食 / 提示音
3. 视觉：光影三档 + 调色 + 少量定向材质
4. 生物补齐（1.17 基线）：蜜蜂、海龟、狐狸、山羊、熊猫（幻翼可选）
5. 世界感与目的性：地标、营地、轻任务线、守卫 Boss
6. 发布：性能矩阵、文档、校验值

内容基线锁定 **Minecraft 1.17**；红石不补全，1.19+ 内容不做。
