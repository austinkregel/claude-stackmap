@rem Shared node resolution for the Windows launchers: scripts\launch.cmd, scripts\guard.cmd,
@rem scripts\hook-open.cmd, and bin\sm.cmd. The twin of scripts/find-node.sh.
@rem
@rem Run with `call`. Sets NODE to a node.exe that runs and is new enough, or leaves NODE undefined.
@rem Every candidate is verified by running it: node.exe on PATH (PATH only, never the current
@rem directory), then the nodejs.org installer's location.
@rem
@rem The minimum is Node 22.13, where `node:sqlite` stopped needing --experimental-sqlite. It must equal
@rem `engines.node` in package.json and NODE_MIN_* in find-node.sh; plugin-test checks all three.
@set "NODE_MIN_MAJOR=22"
@set "NODE_MIN_MINOR=13"
@set "NODE="
@for /f "delims=" %%N in ('where $PATH:node.exe 2^>nul') do @if not defined NODE call :try "%%N"
@if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" call :try "%ProgramFiles%\nodejs\node.exe"
@exit /b 0

:try
@set "CANDIDATE=%~1"
@set "NODE_VERSION="
@for /f "tokens=1,2 delims=v." %%a in ('""%CANDIDATE%" --version" 2^>nul') do @set "NODE_MAJOR=%%a" & set "NODE_MINOR=%%b"
@if not defined NODE_MAJOR exit /b 0
@if %NODE_MAJOR% GTR %NODE_MIN_MAJOR% set "NODE=%CANDIDATE%" & exit /b 0
@if %NODE_MAJOR% LSS %NODE_MIN_MAJOR% exit /b 0
@if %NODE_MINOR% GEQ %NODE_MIN_MINOR% set "NODE=%CANDIDATE%"
@exit /b 0
