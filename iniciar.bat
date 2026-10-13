@echo off
rem Liga o Encaixe/Chapa e abre no navegador. Feche esta janela para desligar.
cd /d "%~dp0"
title Encaixe/Chapa - servidor (nao feche)
set "PY=%LOCALAPPDATA%\Python\bin\python.exe"
if not exist "%PY%" set "PY=python"

rem O motor Rust tem prioridade: se ainda nao foi compilado e o Rust esta instalado, compila agora.
set "CARGO=%USERPROFILE%\.cargo\bin\cargo.exe"
if not exist "motor\target\release\motor.exe" if exist "%CARGO%" (
  echo Compilando o motor Rust pela primeira vez...
  pushd motor
  "%CARGO%" build --release
  popd
)
if not exist "motor\target\release\motor.exe" echo AVISO: motor Rust nao encontrado. O encaixe vai usar o motor Python, bem mais lento.

start "" http://127.0.0.1:8080
"%PY%" server.py
echo.
echo O servidor parou. Veja a mensagem acima.
pause
