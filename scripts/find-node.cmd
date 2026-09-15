@rem Shared node resolution for the Windows launchers: scripts\launch.cmd, scripts\guard.cmd,
@rem scripts\hook-open.cmd, and bin\sm.cmd. The twin of scripts/find-node.sh.
@rem
@rem Run with `call`. Sets NODE to a node.exe that actually runs, or leaves NODE undefined. Every
@rem candidate is verified by running it: node.exe on PATH (PATH only, never the current directory),
@rem then the nodejs.org installer's location.
@set "NODE="
@for /f "delims=" %%N in ('where $PATH:node.exe 2^>nul') do @if not defined NODE "%%N" --version >nul 2>&1 && set "NODE=%%N"
@if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" "%ProgramFiles%\nodejs\node.exe" --version >nul 2>&1 && set "NODE=%ProgramFiles%\nodejs\node.exe"
@exit /b 0
