@echo off
rem Wrapper for guardrail hooks on Windows; the twin of scripts/guard. Usage: guard.cmd <script.mjs>
rem Claude Code runs "${CLAUDE_PLUGIN_ROOT}/scripts/guard" in exec form; Windows resolves it to this file.
rem
rem Fails closed: every internal failure exits 2, the only code that blocks unconditionally.
rem Contrast hook-open.cmd, which wraps informational hooks and fails open.
rem
rem The script name must match [a-z0-9-]+.mjs, so it cannot reach a file outside scripts\.
setlocal EnableExtensions DisableDelayedExpansion
set "NAME=%~1"
set "WHY=no hook script named"
if not defined NAME goto block

set "WHY=invalid hook script name (expected [a-z0-9-]+.mjs)"
if not "%NAME:~-4%"==".mjs" goto block
set "REST=%NAME:~0,-4%"
if not defined REST goto block
:scan
if not defined REST goto named
set "C=%REST:~0,1%"
set "REST=%REST:~1%"
for %%A in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 -) do if "%C%"=="%%A" goto scan
goto block

:named
set "WHY=scripts/%NAME% missing"
if not exist "%~dp0%NAME%" goto block
set "WHY=cannot load node resolution"
if not exist "%~dp0find-node.cmd" goto block
call "%~dp0find-node.cmd"
set "WHY=no usable node binary; install Node 18.17+"
if not defined NODE goto block
"%NODE%" "%~dp0%NAME%"
exit /b %ERRORLEVEL%

:block
>&2 echo stackmap guard: %WHY% - blocking rather than failing open.
exit /b 2
