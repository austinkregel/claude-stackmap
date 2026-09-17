@echo off
rem Wrapper for informational hooks on Windows; the twin of scripts/hook-open. Usage: hook-open.cmd <script.mjs>
rem Claude Code runs "${CLAUDE_PLUGIN_ROOT}/scripts/hook-open" in exec form; Windows resolves it to this file.
rem
rem Fails open, visibly: every failure prints a `systemMessage` and exits 1 (non-blocking), never 0.
rem Contrast guard.cmd, which wraps guardrails and fails closed. Do not mix the two.
rem
rem The script name must match [a-z0-9-]+.mjs, so it can neither escape scripts\ nor break the
rem message's JSON quoting.
setlocal EnableExtensions DisableDelayedExpansion
set "NAME=%~1"
set "WHY=no hook script named"
if not defined NAME goto fail

set "WHY=invalid hook script name (expected [a-z0-9-]+.mjs)"
if not "%NAME:~-4%"==".mjs" goto fail
set "REST=%NAME:~0,-4%"
if not defined REST goto fail
:scan
if not defined REST goto named
set "C=%REST:~0,1%"
set "REST=%REST:~1%"
for %%A in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 -) do if "%C%"=="%%A" goto scan
goto fail

:named
set "WHY=scripts/%NAME% is missing, so that hook did not run"
if not exist "%~dp0%NAME%" goto fail
set "WHY=cannot load node resolution, so %NAME% did not run"
if not exist "%~dp0find-node.cmd" goto fail
call "%~dp0find-node.cmd"
set "WHY=no usable node binary (need Node 22.13+), so %NAME% did not run"
if not defined NODE goto fail
"%NODE%" "%~dp0%NAME%"
exit /b %ERRORLEVEL%

:fail
echo {"systemMessage":"stackmap hook-open: %WHY%"}
>&2 echo stackmap hook-open: %WHY%
exit /b 1
