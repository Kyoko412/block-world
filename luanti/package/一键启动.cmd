@echo off
rem 方块世界 · Luanti 版：从本目录启动，存档与配置保持便携
cd /d "%~dp0"
start "" "%~dp0bin\luanti.exe" --config "%~dp0minetest.conf"
