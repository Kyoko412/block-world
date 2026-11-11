@echo off
rem Launch the NEW version (Luanti + Mineclonia). Classic Electron build is in 启动经典版.bat
cd /d "%~dp0"
start "" "%~dp0游戏\方块世界-Luanti\bin\luanti.exe" --config "%~dp0游戏\方块世界-Luanti\minetest.conf"
