# Block World CN

An offline, single-player voxel sandbox for Windows, built on Luanti and Mineclonia.

**[Download for Windows][release]** · [Build from source](#build-from-source) · [简体中文](README.zh-CN.md)

## Quick start

1. Open the [latest release][release] and download the `block-world-v*.zip` asset.
2. Extract the archive and run `Start.cmd` from the extracted folder.
3. On the **启动游戏** (Start Game) tab, select **blockworld** and start the game.

The portable build runs offline on 64-bit Windows. On the first load, allow time for world generation. Your saves are stored in `worlds/` inside the extracted folder.

## What's included

- The game defaults to **Simplified Chinese**, with a 1080p configuration and WASD controls.
- Custom sound sets cover footsteps, digging, breaking, and placing blocks. Three original tracks are selected for daytime, nighttime, and caves.
- The current source build includes **bees** that visit flowers and return to their nests, with animated wings and custom sounds. Use a **Bee Spawn Egg** in Creative mode to try one.

## Build from source

Use Windows PowerShell with Git installed. The first build needs internet access to download and verify the pinned Luanti and Mineclonia packages. [Dependency lockfile](luanti/dependencies.lock.json)

```powershell
git clone https://github.com/Kyoko412/block-world.git
cd block-world

$luantiRoot = (Resolve-Path .\luanti).Path
$runtime = Join-Path (Get-Location).Path '游戏\方块世界-Luanti'

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\luanti\scripts\fetch-deps.ps1 -Root $luantiRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\luanti\scripts\setup.ps1 -Root $luantiRoot -Target $runtime
Start-Process -FilePath "$runtime\bin\luanti.exe" -WorkingDirectory $runtime -ArgumentList '--config minetest.conf'
```

Create a Mineclonia world in the game menu, then enable `mc_soundpack`, `mc_music`, and `mc_mobs` in that world's mod settings.

### Smoke test

Run from the repository root in Git Bash. The test recreates `.smoke/` beside the playable `worlds/` directory, checks the game registry and sample audio files, and writes `smoke.log` inside the assembled runtime.

```bash
bash luanti/scripts/smoke.sh "$PWD/游戏/方块世界-Luanti"
```

## Architecture

| Component | Role |
| --- | --- |
| [Luanti 5.18.0](https://github.com/luanti-org/luanti) | Engine and rendering |
| [Mineclonia 0.124.1](https://codeberg.org/mineclonia/mineclonia) | World generation, survival, crafting, and base game content |
| [Block World CN](luanti/) | Audio, UI assets, configuration, custom mods, and Windows packaging |

## Project status

Block World CN is in early development, with Minecraft 1.17 as its gameplay reference. Planned work includes lighting presets, color grading, and audio for combat and eating.

When reporting a bug, include the release version, your Windows version, and steps to reproduce it. [GitHub Issues][issues]

## License

Project code is licensed under GPL-3.0-or-later. The notices document the licenses and sources for upstream components and assets. [License](LICENSE) · [Notices](NOTICE.md)

[release]: https://github.com/Kyoko412/block-world/releases/latest
[issues]: https://github.com/Kyoko412/block-world/issues
