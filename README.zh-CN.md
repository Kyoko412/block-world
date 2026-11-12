# 方块世界

基于 Luanti 和 Mineclonia 的 Windows 离线单机方块游戏。

**[下载 Windows 版][release]** · [从源码构建](#从源码构建) · [English](README.md)

## 快速开始

1. 打开[最新发布][release]，在 **Assets** 中下载 `block-world-v*.zip`。
2. 解压后打开解压目录中的 `Start.cmd`。
3. 在「启动游戏」页选择 **blockworld** 世界并开始游戏。

便携包适用于 64 位 Windows，解压后即可离线游玩。首次进入时需要等待世界生成。存档保存在解压目录的 `worlds/` 下。

## 游戏特色

- 默认使用**简体中文**，提供 1080p 配置和 WASD 键位。
- 脚步、挖掘、破坏和放置方块使用各自的音效。三首原创配乐分别用于白天、夜晚和洞穴。
- 当前源码包含会访花和返巢的**蜜蜂**，配有振翅动画和自制音效。在创造模式可用「蜜蜂刷怪蛋」试玩。

## 从源码构建

在装有 Git 的 Windows 上使用 PowerShell。首次构建需要联网下载并校验锁定版本的 Luanti 和 Mineclonia。 [依赖锁文件](luanti/dependencies.lock.json)

```powershell
git clone https://github.com/Kyoko412/block-world.git
cd block-world

$luantiRoot = (Resolve-Path .\luanti).Path
$runtime = Join-Path (Get-Location).Path '游戏\方块世界-Luanti'

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\luanti\scripts\fetch-deps.ps1 -Root $luantiRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\luanti\scripts\setup.ps1 -Root $luantiRoot -Target $runtime
Start-Process -FilePath "$runtime\bin\luanti.exe" -WorkingDirectory $runtime -ArgumentList '--config minetest.conf'
```

在游戏菜单中创建 Mineclonia 世界，然后在该世界的模组设置中启用 `mc_soundpack`、`mc_music` 和 `mc_mobs`。

### 冒烟测试

在仓库根目录用 Git Bash 执行。测试会在 `worlds/` 同级重建 `.smoke/`，检查游戏注册表和样本音频文件，并在组装后的运行目录写入 `smoke.log`。

```bash
bash luanti/scripts/smoke.sh "$PWD/游戏/方块世界-Luanti"
```

## 项目架构

| 组件 | 职责 |
| --- | --- |
| [Luanti 5.18.0](https://github.com/luanti-org/luanti) | 游戏引擎与渲染 |
| [Mineclonia 0.124.1](https://codeberg.org/mineclonia/mineclonia) | 世界生成、生存、合成和基础游戏内容 |
| [方块世界](luanti/) | 音频、界面资源、配置、自定义模组和 Windows 打包 |

## 开发状态

项目处于早期开发阶段，以 Minecraft 1.17 作为玩法参考。后续工作包括光影预设、调色，以及战斗和进食音效。

反馈问题时，请附上发布版本、Windows 版本和复现步骤。 [GitHub Issues][issues]

## 许可

项目代码采用 GPL-3.0-or-later。上游组件及素材的来源和许可见项目声明。 [许可证](LICENSE) · [来源与许可声明](NOTICE.md)

[release]: https://github.com/Kyoko412/block-world/releases/latest
[issues]: https://github.com/Kyoko412/block-world/issues
