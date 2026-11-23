@echo off
setlocal
cd /d "%~dp0"
cargo build --release --locked
if errorlevel 1 exit /b 1
if not exist out mkdir out
copy /y target\release\slice.exe out\slice.exe >nul
for %%F in (out\slice.exe) do echo built %%~fF %%~zF bytes
