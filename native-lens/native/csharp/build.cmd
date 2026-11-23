@echo off
setlocal
set "DOTNET_ROOT=%LOCALAPPDATA%\dotnet-sdk"
set "PATH=%DOTNET_ROOT%;C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%"
set DOTNET_CLI_TELEMETRY_OPTOUT=1
set DOTNET_NOLOGO=1
"%DOTNET_ROOT%\dotnet.exe" publish "%~dp0slice.csproj" -c Release -r win-x64 -o "%~dp0out" || exit /b 1
for %%F in ("%~dp0out\slice.exe") do echo built %%~fF %%~zF bytes
