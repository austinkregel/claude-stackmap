@echo off
rem stackmap CLI on Windows; the twin of bin/sm. Every command reports its counts.
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0..\scripts\find-node.cmd"
if not defined NODE goto nonode
"%NODE%" "%~dp0..\scripts\cli\main.mjs" %*
exit /b %ERRORLEVEL%

:nonode
>&2 echo sm: no usable node binary found. Install Node 18+.
exit /b 127
