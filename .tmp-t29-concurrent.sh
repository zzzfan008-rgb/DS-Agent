#!/usr/bin/env bash
set -u
cd /d/DSSAAS || exit 1
IP=$(wsl hostname -I | awk '{print $1}')
BASE="postgresql://dssaas:dssaas_dev_pw@${IP}:55434/dssaas_test?schema=public"
rm -f .tmp-t29-run1.log .tmp-t29-run2.log .tmp-t29-run1.exit .tmp-t29-run2.exit

run_case() {
  local log="$1" exit_file="$2"
  DSSAAS_DB_REUSE=1 DSSAAS_PG_BASE_URL="$BASE" pnpm test:api > "$log" 2>&1
  echo "$?" > "$exit_file"
}

run_case .tmp-t29-run1.log .tmp-t29-run1.exit &
P1=$!
run_case .tmp-t29-run2.log .tmp-t29-run2.exit &
P2=$!
wait "$P1"
wait "$P2"

echo "run1-exit=$(cat .tmp-t29-run1.exit 2>/dev/null)"
echo "run2-exit=$(cat .tmp-t29-run2.exit 2>/dev/null)"
echo '--- run1 ---'
grep -E '模式=|独立库：|占用锁|已获取|tests |pass |fail |清理完成|总耗时' .tmp-t29-run1.log || true
echo '--- run2 ---'
grep -E '模式=|独立库：|占用锁|已获取|tests |pass |fail |清理完成|总耗时' .tmp-t29-run2.log || true
