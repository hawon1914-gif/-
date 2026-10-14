#!/usr/bin/env sh
# Aero Lab 실행: 로컬 서버를 띄우고 브라우저를 연다 (macOS / Linux)
cd "$(dirname "$0")"
PORT=8000
URL="http://localhost:$PORT"
if command -v python3 >/dev/null 2>&1; then PY=python3; elif command -v python >/dev/null 2>&1; then PY=python; else
  echo "Python이 필요합니다. https://www.python.org 에서 설치한 뒤 다시 실행하세요."; exit 1
fi
( sleep 1; (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") ) &
echo "$URL 에서 실행 중입니다. 끝내려면 Ctrl+C를 누르세요."
exec $PY -m http.server $PORT
