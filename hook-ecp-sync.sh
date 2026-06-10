#!/bin/bash
# Вызывается хуком PostToolUse:Write
# Запускает sync-contracts.js только если сохранён файл *_ЭЦП*.pdf

FILE=$(python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    print(ti.get('file_path', '') if isinstance(ti, dict) else '')
except:
    print('')
" 2>/dev/null)

if [[ "$FILE" == *"_ЭЦП"* && "$FILE" == *".pdf" ]]; then
  echo "🔄 ЭЦП файл сохранён, синхронизирую дашборд..."
  node /Users/tantaklair/Claude-Code-Hello-World/Projects/monitor/sync-contracts.js
fi
