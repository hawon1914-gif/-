@echo off
rem Aero Lab 실행: 로컬 서버를 띄우고 브라우저를 연다 (Windows)
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (where python >nul 2>nul && (set PY=python) || (echo Python이 필요합니다. https://www.python.org 에서 설치한 뒤 다시 실행하세요. & pause & exit /b 1))
start "" http://localhost:8000
echo http://localhost:8000 에서 실행 중입니다. 끝내려면 이 창을 닫으세요.
%PY% -m http.server 8000
