@echo off
title Broken Arrow Court - Publish Read-only Website
powershell.exe -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0Publish.ps1"
