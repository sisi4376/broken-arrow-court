@echo off
title Broken Arrow Court - GitHub Pages Setup
powershell.exe -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0Deploy-GitHubPages.ps1" -Interactive
