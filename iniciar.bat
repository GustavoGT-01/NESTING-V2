@echo off
rem Liga o Encaixe/Chapa e abre no navegador. Feche esta janela para desligar.
cd /d "%~dp0"
title Encaixe/Chapa - servidor (nao feche)

rem Python: prefere o lancador "py -3"; depois o Python da pasta do usuario; por ultimo "python" do PATH.
set "PY="
set "PYARG="
where py >nul 2>nul && set "PY=py" && set "PYARG=-3"
if not defined PY if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY set "PY=python"
"%PY%" %PYARG% -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
if errorlevel 1 (
  echo ERRO: e preciso o Python 3.10 ou mais novo, e ele nao foi encontrado.
  echo Instale o Python em https://www.python.org/downloads/ e abra este arquivo de novo.
  pause
  exit /b 1
)

rem O motor Rust tem prioridade: se o Rust esta instalado, compila sempre (rapido quando nada mudou).
set "CARGO=%USERPROFILE%\.cargo\bin\cargo.exe"
if not exist "%CARGO%" set "CARGO="
if not defined CARGO for /f "delims=" %%c in ('where cargo 2^>nul') do if not defined CARGO set "CARGO=%%c"
if defined CARGO (
  echo Atualizando o motor Rust...
  pushd motor
  "%CARGO%" build --release
  if errorlevel 1 echo AVISO: o motor Rust nao compilou. Segue com o motor ja compilado, se houver, ou com o motor Python.
  popd
)
if not exist "motor\target\release\motor.exe" echo AVISO: motor Rust nao encontrado. O encaixe vai usar o motor Python, bem mais lento.

start "" http://127.0.0.1:8080
"%PY%" %PYARG% server.py
echo.
echo O servidor parou. Veja a mensagem acima.
pause
