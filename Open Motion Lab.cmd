@echo off
if exist "%USERPROFILE%\.local\bin\motion.exe" ("%USERPROFILE%\.local\bin\motion.exe" %*) else (motion %*)
pause
