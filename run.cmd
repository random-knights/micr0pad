@echo off
REM run.cmd - start MicroPad with a sane AIEDS log path.
REM
REM The server reads the AIEDS log from AIEDS_LOG_PATH, falling back to
REM <repo>\aieds-local.jsonl. If this machine already has a workspace log from
REM an earlier install, point at that one so the panel keeps its history;
REM otherwise the repo-local file is used and the hook fills it in over time.

setlocal
if "%AIEDS_LOG_PATH%"=="" (
  if exist "C:\rand0m\_state\aieds-local.jsonl" (
    set "AIEDS_LOG_PATH=C:\rand0m\_state\aieds-local.jsonl"
  )
)
if not "%AIEDS_LOG_PATH%"=="" echo AIEDS log: %AIEDS_LOG_PATH%
node server.js
endlocal
