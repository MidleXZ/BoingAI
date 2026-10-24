@echo off
setlocal EnableExtensions

cd /d "%~dp0"

echo === BoingAI Windows launcher ===

REM --- Build C++ text library ---
pushd boingai\cpp-lib
if not exist include\boing_text.h (echo Missing header & exit /b 1)
cl /nologo /LD /O2 /EHsc /std:c++17 /Iinclude src\boing_text.cpp /Fe:boing_text.dll /link /IMPLIB:boing_text.lib
if errorlevel 1 (echo C++ build failed & popd & exit /b 1)
popd

REM --- Build C# memory service ---
pushd boingai\csharp-service
dotnet build -c Release
if errorlevel 1 (echo C# build failed & popd & exit /b 1)
popd

REM --- Build Rust server ---
pushd boingai\rust-server
cargo build --release
if errorlevel 1 (echo Rust build failed & popd & exit /b 1)
popd

REM --- Start services ---
echo Starting memory service...
start "BoingAI Memory" /min cmd /c "cd /d %~dp0boingai\csharp-service && dotnet run --configuration Release"

echo Starting Rust server...
start "BoingAI Server" /min cmd /c "cd /d %~dp0boingai\rust-server && set FRONTEND_DIR=..\frontend && target\release\boingai-server.exe"

echo Waiting for server...
timeout /t 4 /nobreak >nul

start "" "http://127.0.0.1:8080"

echo BoingAI is running. Close the service windows to stop.
endlocal
