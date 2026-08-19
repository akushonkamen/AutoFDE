#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR=$(cd "$(dirname "$0")" && pwd)

# --- 幂等安装 pi extension ---
EXT_SRC="$BUNDLE_DIR/extensions/screenpipe.ts"
EXT_DST_DIR="$HOME/.pi/agent/extensions"
EXT_DST="$EXT_DST_DIR/screenpipe.ts"

if [[ -f "$EXT_SRC" ]]; then
  mkdir -p "$EXT_DST_DIR"
  src_hash=$(shasum -a 256 "$EXT_SRC" | awk '{print $1}')
  dst_hash=$([[ -f "$EXT_DST" ]] && shasum -a 256 "$EXT_DST" | awk '{print $1}' || true)
  if [[ -z "$dst_hash" ]]; then
    cp "$EXT_SRC" "$EXT_DST"
    echo "[autofde] 已安装 pi extension: screenpipe.ts（首次安装）"
  elif [[ "$src_hash" != "$dst_hash" ]]; then
    cp "$EXT_SRC" "$EXT_DST"
    echo "[autofde] 已更新 pi extension: screenpipe.ts"
  fi
else
  echo "[autofde] 警告: 包内缺少 $EXT_SRC，跳过 extension 安装" >&2
fi

# --- pipes 安装（二期）---
# 待上游引擎发布含 /work-history 端点的版本后，随版本 bump 收录
# work-history-memory 与 automate-my-work 两个 pipes。届时安装规则：
#   对比 ~/.screenpipe/pipes/<name>/pipe.md 与包内 pipes/<name>/pipe.md，
#   内容不同才拷贝；只动 pipe.md，绝不触碰 pipe 目录下的用户本地状态
#   （如 local-overrides 的启停配置）。

# --- 启动 ---
export PI_SCREENPIPE_BIN="$BUNDLE_DIR/bin/screenpipe"
exec "$BUNDLE_DIR/pi" "$@"
