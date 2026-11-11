#!/usr/bin/env bash
# 冒烟测试：临时世界 + 注册表断言。用法： bash luanti/scripts/smoke.sh <目标目录>
set -u
TARGET="${1:?用法: smoke.sh <目标目录>}"
WORLD="$TARGET/worlds/_smoke"
PROBE="$WORLD/worldmods/_smoke_probe"
EXE="$TARGET/bin/luanti.exe"

[ -x "$EXE" ] || [ -f "$EXE" ] || { echo "找不到 luanti.exe"; exit 2; }
rm -rf "$WORLD"
mkdir -p "$PROBE"

cat > "$PROBE/mod.conf" <<'EOF'
name = _smoke_probe
description = registry probe for smoke test
EOF

cat > "$PROBE/init.lua" <<'EOF'
minetest.register_on_mods_loaded(function()
  local nodes, items, entities = 0, 0, 0
  for _ in pairs(minetest.registered_nodes) do nodes = nodes + 1 end
  for _ in pairs(minetest.registered_items) do items = items + 1 end
  for _ in pairs(minetest.registered_entities) do entities = entities + 1 end
  local f = io.open(minetest.get_worldpath() .. "/smoke.txt", "w")
  f:write("nodes=" .. nodes .. "\nitems=" .. items .. "\nentities=" .. entities ..
    "\nhas_bee=" .. tostring(minetest.registered_entities["mc_mobs:bee"] ~= nil) ..
    "\nhas_stone=" .. tostring(minetest.registered_nodes["mcl_core:stone"] ~= nil) .. "\n")
  f:close()
  minetest.request_shutdown()
end)
EOF

cat > "$WORLD/world.mt" <<'EOF'
gameid = mineclonia
world_name = _smoke
backend = sqlite3
player_backend = sqlite3
auth_backend = sqlite3
mod_storage_backend = sqlite3
load_mod_mc_soundpack = true
load_mod_mc_music = true
load_mod_mc_mobs = true
EOF

cd "$TARGET" || exit 2
timeout 120 ./bin/luanti.exe --server --world "worlds/_smoke" --port 39977 > smoke.log 2>&1
CODE=$?

RESULT="$WORLD/smoke.txt"
[ -f "$RESULT" ] || { echo "冒烟失败：探针没有写出结果（exit=$CODE），见 $TARGET/smoke.log"; exit 1; }

get() { grep -m1 "^$1=" "$RESULT" | cut -d= -f2; }
NODES=$(get nodes); ITEMS=$(get items); ENTS=$(get entities); BEE=$(get has_bee); STONE=$(get has_stone)
FAIL=""
[ "${NODES:-0}" -ge 2890 ] || FAIL="$FAIL 节点数异常($NODES);"
[ "${ENTS:-0}" -ge 289 ] || FAIL="$FAIL 实体数异常($ENTS);"
[ "$BEE" = "true" ] || FAIL="$FAIL mc_mobs:bee 未注册;"
[ "$STONE" = "true" ] || FAIL="$FAIL mcl_core:stone 缺失;"
[ -f "$TARGET/mods/mc_music/sounds/mc_music_day.ogg" ] || FAIL="$FAIL 配乐文件缺失;"
[ -f "$TARGET/mods/mc_soundpack/sounds/mc_dig_stone.ogg" ] || FAIL="$FAIL 音效文件缺失;"

if [ -n "$FAIL" ]; then echo "冒烟失败：$FAIL"; exit 1; fi
echo "冒烟通过：nodes=$NODES items=$ITEMS entities=$ENTS bee=$BEE 退出码=$CODE"
exit 0
