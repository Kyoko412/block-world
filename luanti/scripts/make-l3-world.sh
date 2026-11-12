#!/usr/bin/env bash
# 生成一个 L3 验收世界（平台由 l3 mod 在首次进入时自动搭建）
# 用法： bash luanti/scripts/make-l3-world.sh [游戏目录]
set -u
TARGET="${1:-E:/MinecraftOffline/游戏/方块世界-Luanti}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="$TARGET/worlds/L3-test"

rm -rf "$WORLD"
mkdir -p "$WORLD/worldmods"
cp -r "$HERE/tests/l3" "$WORLD/worldmods/l3"

cat > "$WORLD/world.mt" <<'MT'
gameid = mineclonia
world_name = L3-test
backend = sqlite3
player_backend = sqlite3
auth_backend = sqlite3
mod_storage_backend = sqlite3
creative_mode = false
enable_damage = true
load_mod_l3 = true
load_mod_mc_soundpack = true
load_mod_mc_music = true
load_mod_mc_mobs = true
load_mod_mc_creative = true
MT

echo "已创建：$WORLD"
echo "启动游戏 → 选择世界 L3-test → 聊天框输入 /l3 看清单；/l3kit N 领该站道具。"
