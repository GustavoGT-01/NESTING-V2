@echo off
rem Liga o Encaixe/Chapa e abre no navegador. Feche esta janela para desligar.
cd /d "%~dp0"
title Encaixe/Chapa - servidor (nao feche)
set "PY=%LOCALAPPDATA%\Python\bin\python.exe"
if not exist "%PY%" set "PY=python"
start "" http://127.0.0.1:8080
"%PY%" server.py
echo.
echo O servidor parou. Veja a mensagem acima.
pause
