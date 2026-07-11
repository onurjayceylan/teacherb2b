#!/bin/sh
# MODE=web (varsayılan) → Next sunucusu; MODE=worker → pg-boss worker'ı.
set -e
if [ "$MODE" = "worker" ]; then
  exec pnpm --filter @teachernow/worker start
fi
exec pnpm --filter @teachernow/web start
