@echo off
chcp 65001 >nul
rem 자동 실행 등록을 지우고 켜져 있는 브리지를 끕니다.
call "%~dp0start_lmu_bridge.bat" --uninstall
