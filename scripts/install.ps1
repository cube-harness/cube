param(
  [string]$BaseUrl = 'https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev',
  [string]$ArchivePath,
  [string]$Sha256,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Cube'),
  [switch]$NoPathUpdate
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw 'This installer supports Windows x64 only. Run it in 64-bit PowerShell.'
}
$installRoot = [IO.Path]::GetFullPath($InstallDir)
if ($installRoot -eq [IO.Path]::GetPathRoot($installRoot) -or $installRoot -eq [Environment]::GetFolderPath('UserProfile')) {
  throw 'Choose a dedicated Cube installation directory.'
}
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$staging = Join-Path $installRoot ('.install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  if (-not $ArchivePath) {
    if (-not $BaseUrl -or ([uri]$BaseUrl).Scheme -ne 'https') { throw 'Provide an HTTPS -BaseUrl or a local -ArchivePath with -Sha256.' }
    $base = $BaseUrl.TrimEnd('/')
    $manifest = Invoke-RestMethod "$base/latest.json"
    if ($manifest.platform -ne 'win32-x64' -or $manifest.file -notmatch '^releases/[a-zA-Z0-9._-]+/cube-windows-x64\.zip$') {
      throw 'Invalid Windows package manifest.'
    }
    $Sha256 = $manifest.sha256
    $ArchivePath = Join-Path $staging 'cube.zip'
    Invoke-WebRequest "$base/$($manifest.file)" -OutFile $ArchivePath -UseBasicParsing
  }
  if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'A valid SHA-256 is required.' }
  if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $Sha256) { throw 'Package checksum mismatch. Existing installation is unchanged.' }
  $versionKey = $Sha256.ToLowerInvariant().Substring(0, 16)
  $expanded = Join-Path $staging 'package'
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $expanded
  foreach ($required in @('runtime/node.exe', 'cube.cmd', 'app/dist/main.js', 'app/package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $expanded $required) -PathType Leaf)) { throw "Incomplete package: $required" }
  }
  & (Join-Path $expanded 'runtime/node.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'The bundled Node runtime cannot start.' }
  $versions = Join-Path $installRoot 'versions'
  $destination = Join-Path $versions $versionKey
  $bin = Join-Path $installRoot 'bin'
  New-Item -ItemType Directory -Path $versions, $bin -Force | Out-Null
  if (-not (Test-Path -LiteralPath $destination)) {
    Move-Item -LiteralPath $expanded -Destination $destination
  } elseif (-not (Test-Path -LiteralPath (Join-Path $destination 'app/dist/main.js'))) {
    throw "Incomplete existing installation at $destination; it has not been overwritten."
  }
  $launcher = "@echo off`r`nsetlocal`r`nset `"PATH=%~dp0..\versions\$versionKey\runtime;%PATH%`"`r`n`"%~dp0..\versions\$versionKey\runtime\node.exe`" `"%~dp0..\versions\$versionKey\app\dist\main.js`" %*`r`nexit /b %errorlevel%`r`n"
  $launcherTemp = Join-Path $bin ('cube-' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($launcherTemp, $launcher, [Text.Encoding]::ASCII)
  Move-Item -LiteralPath $launcherTemp -Destination (Join-Path $bin 'cube.cmd') -Force
  if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $bin) {
      [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $userPath).TrimEnd(';'), 'User')
    }
    if (($env:PATH -split ';') -notcontains $bin) { $env:PATH = "$bin;$env:PATH" }
  }
  Write-Host "Cube installed: $bin\cube.cmd"
  Write-Host 'Run cube from your project directory. Existing ~/.cube data was not changed.'
} finally {
  $resolvedStage = [IO.Path]::GetFullPath($staging)
  if ($resolvedStage.StartsWith($installRoot.TrimEnd('\') + '\.install-', [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
