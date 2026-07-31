#!/usr/bin/env bash
set -u
ROOT="$1"
cd /Users/dan/code/ideate/plugin/scripts/migrate-v2
node migrate.mjs "$ROOT" 2>&1 | grep -vE "ExperimentalWarning|trace-warnings" | grep -E "===|steering:|failed|! |ERROR|already|wrote"
BOARD="$ROOT/.ideate-work/board.db"
if [ -f "$BOARD" ]; then
  sqlite3 "$BOARD" "SELECT '  board-integrity: '||(SELECT count(*) FROM items)||' items | '||coalesce((SELECT count(*) FROM items,json_each(depends_on)),0)||' dep-edges | '||coalesce((SELECT sum(j.value IN (SELECT id FROM items)) FROM items,json_each(depends_on) j),0)||' resolve to real items';" 2>/dev/null
fi
RC=$(find "$ROOT/.ideate/record" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
ST=$(ls "$ROOT/.ideate/steering"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "  on-disk: $RC record files, $ST steering files"
WI=$(ls "$ROOT/.ideate/work-items"/*.yaml 2>/dev/null | wc -l | tr -d ' ')
PR=$(ls "$ROOT/.ideate/principles"/*.yaml 2>/dev/null | wc -l | tr -d ' ')
SEN=$([ -f "$ROOT/.ideate/.migrated-to-v3.json" ] && echo yes || echo NO)
echo "  v2-intact: work-items=$WI principles=$PR | sentinel=$SEN"
