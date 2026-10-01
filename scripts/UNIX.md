# Linux / WSL and macOS distribution

Targets: Linux x64 (including WSL Ubuntu), macOS Apple Silicon and Intel.
Build on the actual OS/architecture; do not copy Windows node_modules to Unix.
Linux packages target glibc, not Alpine/musl. macOS builds are not signed or notarized.

Use Node 24.14.0 and pnpm 11.5.3:

```sh
pnpm install --frozen-lockfile
pnpm package:app
node scripts/install-smoke.mjs build/linux-x64/cube-linux-x64.tar.gz
```

For macOS replace `linux-x64` with `darwin-arm64` or `darwin-x64`.
Output: `build/<target>/cube-<target>.tar.gz`, `.sha256`, `latest.json`,
`latest-<target>.txt`, and `install.sh`. Node, production dependencies, templates
and licenses are included. The Windows command and ZIP layout remain unchanged.
The shared build smoke checks templates, native read/list/grep without rg, custom
commands and SQLite outside the checkout. The installer smoke uses the archive,
an isolated installation directory and a launcher probe; it does not test TUI rendering.

Local installation (no sudo, no existing Node required):

```sh
sh scripts/install.sh --archive "$PWD/build/linux-x64/cube-linux-x64.tar.gz" \
  --sha256 "$(tr -d '\r\n' < build/linux-x64/cube-linux-x64.tar.gz.sha256)"
```

Default application files: `~/.local/share/cube/versions/<checksum-prefix>`.
Launcher: `~/.local/bin/cube`. Add `~/.local/bin` to PATH if needed; the installer
does not edit shell profiles. It preserves the current working directory, forwards
arguments and uses its bundled Node. Config/auth remain in the existing `~/.cube`
(inside the Linux home when using WSL); installation does not read or modify them.
Previous versions are retained. `--install-dir` and `--bin-dir` accept absolute
paths for isolated testing. Existing non-Cube launchers are not overwritten.

## CI and downloads

The single `Cube package` workflow (`.github/workflows/package.yml`) builds Windows,
Linux/WSL, macOS ARM64 and macOS Intel, runs package smoke tests (plus installer
smoke tests on Unix), then stores private workflow artifacts. One publish job waits
for all four targets to succeed.
Runner labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Publishing is manual opt-in and requires the same R2 secrets/variables as Windows.
No workflow is dispatched by adding these files.

Unix installs use a two-field text manifest (SHA-256 and immutable relative archive
path), so installing does not require a JSON parser, Node, Python or jq. Manifests
are named `latest-linux-x64.txt`, `latest-darwin-arm64.txt`, `latest-darwin-x64.txt`.
Publishing uploads all archives before installer/manifests, including the existing
Windows `latest.json` and `install.ps1`. The version comes from the root `package.json`,
which the maintainer bumps manually. Archives use `releases/<version>/<filename>`;
an existing version fails publishing before any upload. Cleanup runs only after all
uploads succeed and keeps the active archive plus newest previous archive per platform.
Local installations still use checksum-named directories and verify SHA-256.
Unix manifests remain separate. A checksum detects damage, not a compromised
download host; these packages are not independently signed.

After a verified build has been published:

```sh
curl -fsSL https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev/install.sh | sh
```

Run this inside WSL for Linux, or Terminal for macOS. The URL will not serve these
new targets until you explicitly publish the combined workflow.

Installed Cube checks its platform's `latest-<target>.txt` on startup, with a
3-second timeout. A different checksum opens the onboarding Update/Continue/Cancel
picker. Update verifies the archive and hands control back to the launcher after
the old Node process exits; the existing installer updates the symlink and reopens
Cube in the same workspace. Errors become system notices in the previous build,
not raw installer output. Config, auth and history under `~/.cube` remain untouched.
Source/development runs skip the check. There is no background updater.
