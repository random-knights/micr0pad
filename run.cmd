@echo off
REM run.cmd - start MicroPad with a sane AiEDs log path.
REM
REM The server reads the AiEDs log from AIEDS_LOG_PATH, falling back to
REM <repo>\aieds-local.jsonl. If AIEDS_LOG_PATH is already set in the
REM environment it is left alone. Otherwise, if a log exists in a _state folder
REM beside the repo - the layout this app grew up in - that one is used, so an
REM existing history keeps showing.

setlocal
if "%AIEDS_LOG_PATH%"=="" (
  if exist "%~dp0..\_state\aieds-local.jsonl" (
    set "AIEDS_LOG_PATH=%~dp0..\_state\aieds-local.jsonl"
  )
)
if not "%AIEDS_LOG_PATH%"=="" echo AiEDs log: %AIEDS_LOG_PATH%
node server.js
endlocal
