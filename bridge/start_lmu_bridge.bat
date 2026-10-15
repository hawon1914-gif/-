@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (where python >nul 2>nul && (set PY=python) || (echo Python 3.8 이상이 필요합니다. https://www.python.org 에서 설치하세요. & pause & exit /b 1))
%PY% lmu_bridge.py %*
pause
