# Windows x64 distribution

The repository stays private. GitHub Actions builds a portable ZIP and can upload it
to Cloudflare R2 only when a maintainer manually selects `publish`. No GitHub release
or public npm package is required. The package includes JavaScript, not source-code
protection, and is not code-signed yet.

## Local build and installation

Run `pnpm package:windows` on Windows x64 with Node 24.14.0 and pnpm 11.5.3.
The build copies production dependencies, Node, templates and licenses; it runs a
smoke check using a temporary home/workspace outside the checkout. It does not read
or package the developer's `~/.cube`, API keys or environment files.

Build output is `build/windows/cube-windows-x64.zip`, its `.sha256` checksum,
`latest.json`, and `install.ps1`. Local installation:

```powershell
& .\scripts\install.ps1 -ArchivePath .\build\windows\cube-windows-x64.zip -Sha256 (Get-Content .\build\windows\cube-windows-x64.zip.sha256 -Raw).Trim()
```

Then open a terminal in another project and run `cube`. Installation uses
`%LOCALAPPDATA%\cube`; personal configuration stays in `~/.cube`. On a clean home,
the normal onboarding screen requests credentials. Successful installation switches
the launcher before removing older checksum-named directories under `versions`.
For an isolated test,
pass `-InstallDir <temporary-directory> -NoPathUpdate`.

## Private CI and public downloads

Configure a dedicated R2 bucket with a public custom domain. In the private GitHub
repository configure secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (write access
limited to this bucket), and variables `R2_ENDPOINT` (HTTPS S3 endpoint) and
`R2_BUCKET`. The Windows publish runner needs the AWS CLI.

Run the single `Cube package` workflow (`.github/workflows/package.yml`) for all
four targets: Windows, Linux/WSL, macOS Apple Silicon and Intel. It publishes only
after every target passes and `publish` is selected; otherwise it only saves artifacts.

Release version comes from the root `package.json`; bump it manually before publishing.
Archives live at `releases/<version>/cube-<target>.<extension>`. If any object already
exists under that version, publishing fails before uploading anything, including after
a partial publish. All platform artifacts must declare the same version.
The workflow uploads all immutable archives first, then installers and manifests.
Only after every upload succeeds does cleanup keep the active archive and newest
previous archive per platform. Failed builds/uploads never delete old releases.
SHA-256 still verifies the downloaded file; local `versions` directories remain hash-named.
Do not cache `latest.json` or `install.ps1` as immutable. A checksum detects a damaged
download; it is not an independent signature if the download host is compromised.

End-user PowerShell one-liner:

```powershell
irm https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev/install.ps1 | iex
```

No CI workflow or upload has been executed just by adding these files. Validate the
ZIP installer locally before enabling publishing.

Installed Cube checks `latest.json` on startup (3-second timeout), comparing the
published checksum with the running build; release version names do not replace checksum verification.
Onboarding offers Update, Continue, or Cancel (Esc/Ctrl+C exits). Update downloads
and verifies the archive, exits the old Node process, then the launcher runs the
installer and opens Cube again in the same workspace. Installer output is captured;
failure returns to the previous build with a system notice. `~/.cube` is unchanged.
Source/development runs and portable archives outside `versions` skip this check.
There is no background updater, and publication remains manual opt-in.
