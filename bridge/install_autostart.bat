@echo off
chcp 65001 >nul
rem 한 번만 실행: Windows에 로그인하면 브리지가 창 없이 자동으로 켜지고, 게임에서 트랙에 나가면 Aero Lab이 열립니다.
call "%~dp0start_lmu_bridge.bat" --install
