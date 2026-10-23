@echo off
rem token-guard: resolve o node ao disparar (PATH, depois locais conhecidos); nenhum caminho fica gravado.
set "TG_SCRIPT=%~dp0daemon-server.cjs"
where node >nul 2>&1
if not errorlevel 1 (
  node "%TG_SCRIPT%"
  exit /b
)
if exist "%ProgramFiles%\nodejs\node.exe" "%ProgramFiles%\nodejs\node.exe" "%TG_SCRIPT%" & exit /b
if exist "%ProgramFiles(x86)%\nodejs\node.exe" "%ProgramFiles(x86)%\nodejs\node.exe" "%TG_SCRIPT%" & exit /b
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%TG_SCRIPT%" & exit /b
if exist "%NVM_SYMLINK%\node.exe" "%NVM_SYMLINK%\node.exe" "%TG_SCRIPT%" & exit /b
if exist "%VOLTA_HOME%\bin\node.exe" "%VOLTA_HOME%\bin\node.exe" "%TG_SCRIPT%" & exit /b
echo token-guard: node nao encontrado no PATH nem nos locais conhecidos 1>&2
exit /b 1
