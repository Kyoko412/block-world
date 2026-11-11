#!/usr/bin/env bash
# 内容审计：在临时世界里跑 luanti/tests/audit，输出 artifacts/audit/audit.txt
# 用法： bash luanti/scripts/audit.sh <游戏目录> [输出目录]
set -u
TARGET="${1:?用法: audit.sh <游戏目录> [输出目录]}"
OUTDIR="${2:-E:/MinecraftOffline/artifacts/audit}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="$TARGET/worlds/_audit"

rm -rf "$WORLD"
mkdir -p "$WORLD/worldmods"
cp -r "$HERE/tests/audit" "$WORLD/worldmods/audit"

cat > "$WORLD/world.mt" <<'MT'
gameid = mineclonia
world_name = _audit
backend = sqlite3
player_backend = sqlite3
auth_backend = sqlite3
mod_storage_backend = sqlite3
MT

cd "$TARGET" || exit 2
timeout 180 ./bin/luanti.exe --server --world "worlds/_audit" --port 39956 > audit.log 2>&1
CODE=$?

mkdir -p "$OUTDIR"
if [ -f "$WORLD/audit.txt" ]; then
  cp "$WORLD/audit.txt" "$OUTDIR/audit.txt"
  head -8 "$OUTDIR/audit.txt"
  echo "完整报告：$OUTDIR/audit.txt"
else
  echo "审计失败（exit=$CODE），见 $TARGET/audit.log"
  exit 1
fi
rm -rf "$WORLD"
