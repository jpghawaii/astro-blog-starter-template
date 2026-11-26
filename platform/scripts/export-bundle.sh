#!/usr/bin/env bash
# Exports the real (non-demo) data of a local database as a gzipped, data-only SQL bundle for
# /admin/restore on a fresh deployment. Excludes users/sessions/audit and the reference tables
# that migrations create. The bundle contains CONFIDENTIAL data: never commit it.
set -euo pipefail
DB_URL="${1:?usage: scripts/export-bundle.sh <database-url> [out.sql.gz]}"
OUT="${2:-data/private/jpg-data-bundle-$(date +%Y%m%d).sql.gz}"
pg_dump "$DB_URL" --data-only --inserts --rows-per-insert=200 --no-owner --no-privileges \
  -T app_user -T app_session -T audit_log -T schema_migration -T spatial_ref_sys \
  -T source_dataset -T media_format -T metric_definition -T model_assumption \
  | grep -vE '^\\(un)?restrict ' | gzip -9 > "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
