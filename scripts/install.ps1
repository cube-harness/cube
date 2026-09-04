# Cube CLI - Windows Installer (PowerShell)
# Usage: irm https://raw.githubusercontent.com/<owner>/cube-releases/main/install.ps1 | iex

param (
    [string]$Repo = "your-username/cube-releases",
    [string]$Version = "latest",
    [string]$BaseUrl = ""
)

$ErrorActionPreference = "Stop"

# Colors & Formatting
function Write-CubeHeader {
    Write-Host ""
    Write-Host "   _______   " -ForegroundColor Cyan
    Write-Host "  /\      \  " -ForegroundColor Cyan
    Write-Host " /  \      \ " -ForegroundColor Cyan
    Write-Host "/    \______\" -ForegroundColor Cyan
    Write-Host "\    /      /" -ForegroundColor DarkCyan
    Write-Host " \  /      / " -ForegroundColor DarkCyan
    Write-Host "  \/______/  " -ForegroundColor DarkCyan
    Write-Host "  Cube CLI Installer" -ForegroundColor White -NoNewline
    Write-Host " [Windows x64]" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Success($message) {
    Write-Host "  ✔ " -ForegroundColor Green -NoNewline
    Write-Host $message -ForegroundColor White
}

function Write-Info($message) {
    Write-Host "  • " -ForegroundColor Cyan -NoNewline
    Write-Host $message -ForegroundColor DarkGray
}

function Write-Warn($message) {
    Write-Host "  ⚠ " -ForegroundColor Yellow -NoNewline
    Write-Host $message -ForegroundColor Yellow
}

function Write-Failure($message) {
    Write-Host "  ✖ " -ForegroundColor Red -NoNewline
    Write-Host $message -ForegroundColor Red
    Exit 1
}

Write-CubeHeader

# 1. Check Node.js prerequisite
Write-Info "Checking system prerequisites..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn "Node.js (>= 22.0.0) is recommended to run Cube."
    Write-Warn "Download Node.js from: https://nodejs.org/"
} else {
    $nodeVer = & node -v
    Write-Success "Found Node.js ($nodeVer)"
}

# 2. Setup install directories
$InstallDir = Join-Path $env:USERPROFILE ".cube"
$BinDir = Join-Path $InstallDir "bin"
$TempZip = Join-Path ([System.IO.Path]::GetTempPath()) "cube-windows-x64.zip"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

# 3. Determine Download URL
$PackageName = "cube-windows-x64.zip"
if ($BaseUrl -ne "") {
    $DownloadUrl = "$BaseUrl/$PackageName"
} elseif ($Version -eq "latest") {
    $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$PackageName"
} else {
    $DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$PackageName"
}

Write-Info "Downloading Cube package from:"
Write-Host "    $DownloadUrl" -ForegroundColor DarkGray

try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls13
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing
    Write-Success "Download completed"
} catch {
    Write-Failure "Failed to download Cube package: $_"
}

# 4. Extract archive
Write-Info "Extracting files to $BinDir..."
try {
    Expand-Archive -Path $TempZip -DestinationPath $BinDir -Force
    Remove-Item -Path $TempZip -Force -ErrorAction SilentlyContinue
    Write-Success "Extracted files successfully"
} catch {
    Write-Failure "Failed to extract package: $_"
}

# 5. Add to User PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -split ";" -notcontains $BinDir) {
    Write-Info "Adding $BinDir to User PATH..."
    $NewPath = "$UserPath;$BinDir"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    $env:Path = "$env:Path;$BinDir"
    Write-Success "Updated User PATH"
} else {
    $env:Path = "$env:Path;$BinDir"
    Write-Success "PATH is already configured"
}

# 6. Finish
Write-Host ""
Write-Host "╭─────────────────────────────────────────────────────────────╮" -ForegroundColor Cyan
Write-Host "│  🎉 Cube CLI has been installed successfully!              │" -ForegroundColor White
Write-Host "│                                                             │" -ForegroundColor Cyan
Write-Host "│  👉 Restart your terminal or run:                           │" -ForegroundColor Gray
Write-Host "│     cube                                                    │" -ForegroundColor Green
Write-Host "╰─────────────────────────────────────────────────────────────╯" -ForegroundColor Cyan
Write-Host ""
