@echo off
chcp 65001 >nul
rem 이것 하나만 실행하면 됩니다: 브리지를 켜고 Aero Lab을 엽니다. 게임은 그 뒤에 켜고 달리면 자동으로 연결·기록됩니다.
rem 끝내려면 작업 표시줄의 "Aero Lab 브리지" 창을 닫으세요.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (where python >nul 2>nul && (set PY=python) || (echo Python 3.8 이상이 필요합니다. https://www.python.org 에서 설치하세요. & pause & exit /b 1))
start "Aero Lab 브리지" /min %PY% lmu_bridge.py --open
