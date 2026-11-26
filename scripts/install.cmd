@echo off
setlocal
rem CMD bootstrap; PowerShell owns installation and forwards its exit status.
rem Always the released installer: this file is run from wherever it was saved, and an install.ps1 beside it can be anyone's.
set "PANCODE_BOOTSTRAP_FILE=%TEMP%\pancode-install-%RANDOM%-%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://github.com/PanStudio/pancode/releases/latest/download/install.ps1' -OutFile $env:PANCODE_BOOTSTRAP_FILE"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PANCODE_BOOTSTRAP_FILE%" %*
set "PANCODE_BOOTSTRAP_EXIT=%errorlevel%"
del /q "%PANCODE_BOOTSTRAP_FILE%"
exit /b %PANCODE_BOOTSTRAP_EXIT%
