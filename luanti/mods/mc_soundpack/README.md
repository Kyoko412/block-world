# mc_soundpack（Luanti 版）

把「方块世界」已验收的移动 / 挖掘 / 破坏 / 放置音效接到 Luanti + Mineclonia 上。

- `sounds/`：80 个单声道 OGG，按 Luanti 声音组命名（`mc_dig_stone.ogg` + `.0/.1/.2`），
  引擎播放时自己随机挑一条，对应我们原本的 `_b/_c/_d` 变体。
- `init.lua`：在 `register_on_mods_loaded` 之后，遍历已注册节点，**按 footstep / dig / dug / place
  四个键位分别重映射**。不能按名字一刀切——Mineclonia 里石头的 `dug` 复用了
  `default_hard_footstep`，按名字替换会把破坏声变成脚步声。
- `player_damage` / `player_falling_damage` / `player_jump` 是引擎内置特殊组，只需放文件。
- 实测：重映射 2776 个节点 / 10861 个声音键位，无 Lua 错误（Luanti 5.18.0 + Mineclonia 0.124.1）。

## 重新生成

```
node .tools/ogg-pack.mjs         # app/renderer/media/sfx/*.wav → 本目录 sounds/
cp -r luanti/mods/mc_soundpack/. "游戏/方块世界-Luanti/mods/mc_soundpack/"
```

## 安装

便携包内 `mods/mc_soundpack/`，世界 `world.mt` 里加 `load_mod_mc_soundpack = true`。
（示例世界：`游戏/方块世界-Luanti/worlds/mcsound/`）
