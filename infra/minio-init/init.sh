#!/bin/sh
# =============================================================
# t34：MinIO 一次性初始化（单桶 + 版本化）。
#
# 用法 A（compose，推荐）：
#   docker compose -f infra/docker-compose.yml --profile init up minio-init
# 用法 B（本机已装 mc）：
#   MINIO_ENDPOINT=http://127.0.0.1:9000 \
#   MINIO_ROOT_USER=dssaas MINIO_ROOT_PASSWORD=... \
#   sh infra/minio-init/init.sh
#
# 幂等：mc mb --ignore-existing / mc version enable 可重复执行。
# 注意：本机 docker pull minio/minio 被 registry 拒绝，脚本未在本机实跑；
#       上线/CI 必须先执行本脚本（见 docs/验收记录-M6-媒体.md §7）。
# =============================================================
set -eu

MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-dssaas}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-dssaas_dev_pw}"
MEDIA_BUCKET="${MEDIA_BUCKET:-dssaas-media}"
MINIO_ALIAS="${MINIO_ALIAS:-local}"

echo "[minio-init] endpoint=${MINIO_ENDPOINT} bucket=${MEDIA_BUCKET}"

# 等待 MinIO 就绪：alias set 会在连接失败时返回非 0。
attempt=0
until mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "[minio-init] MinIO 未就绪（等待 120s 超时）" >&2
    exit 1
  fi
  sleep 2
done

mc mb --ignore-existing "$MINIO_ALIAS/$MEDIA_BUCKET"
mc version enable "$MINIO_ALIAS/$MEDIA_BUCKET"

echo "[minio-init] buckets:"
mc ls "$MINIO_ALIAS"
echo "[minio-init] versioning:"
mc version info "$MINIO_ALIAS/$MEDIA_BUCKET"
