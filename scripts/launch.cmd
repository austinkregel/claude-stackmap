@echo off
rem Launch the stackmap MCP server on Windows; the twin of scripts/launch.
rem .mcp.json names "${CLAUDE_PLUGIN_ROOT}/scripts/launch"; Windows resolves it to this file.
rem Every failure exits with a message on stderr, never silently.
setlocal EnableExtensions DisableDelayedExpansion
set "ENTRY=%~dp0..\dist\index.js"
call "%~dp0find-node.cmd"
if not defined NODE goto nonode
if not exist "%ENTRY%" goto nobuild
"%NODE%" "%ENTRY%" %*
exit /b %ERRORLEVEL%

:nonode
>&2 echo stackmap: no usable node binary found. Install Node 22.13+ from nodejs.org, or put node.exe on PATH.
exit /b 1

:nobuild
>&2 echo stackmap: %ENTRY% is missing. Run "npm install" and then "npm run build" in %~dp0..
exit /b 1
