@echo off
REM run.cmd - start MicroPad from a checkout on Windows.
REM
REM The server reads the AiEDs log from AIEDS_LOG_PATH when it is set, and
REM otherwise from aieds-local.jsonl in %APPDATA%\micr0pad, the same per-user
REM folder that holds config.json. Set AIEDS_LOG_PATH in your environment to
REM keep an existing log somewhere else; this script leaves it alone.

setlocal
if not "%AIEDS_LOG_PATH%"=="" echo AiEDs log: %AIEDS_LOG_PATH%
node "%~dp0server.js"
endlocal
