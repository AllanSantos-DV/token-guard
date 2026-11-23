@echo off
setlocal
cd /d "%~dp0"
if not exist out mkdir out
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-s -w" -o out\slice.exe .
if errorlevel 1 exit /b 1
for %%F in (out\slice.exe) do echo built %%~fF %%~zF bytes
