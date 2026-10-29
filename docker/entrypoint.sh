#!/bin/sh
set -e

DATA_DIR="${DATASENTRY_DATA_DIR:-/app/data}"

# 只在数据卷为空时播种：已有数据时 restart 不会覆盖用户的状态库与产物。
if [ "${DATASENTRY_SEED:-1}" = "1" ]; then
  if [ ! -f "$DATA_DIR/warehouse.db" ] || [ ! -f "$DATA_DIR/manual-adjustments.xlsx" ]; then
    echo "[entrypoint] 首次启动：生成模拟数据（SQLite 数仓 + 手工调整 Excel）"
    npm run seed
  fi
  if [ ! -d "$DATA_DIR/pg" ]; then
    echo "[entrypoint] 首次启动：初始化经营报表库（内嵌 PGlite）"
    npm run seed:pg
  fi
fi

exec "$@"
