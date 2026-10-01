# Cube CLI

Production-Grade Interactive Coding Agent CLI.

## Quick Start

Run directly without installing:

```bash
npx @cube-harness/cli
```

Or install globally:

```bash
npm install -g @cube-harness/cli
```

Then run anywhere:

```bash
cube
```

## How It Works

This package is a lightweight, zero-dependency launcher. On first run, it automatically fetches and caches the verified native standalone binary for your operating system (Windows, Linux, or macOS) from Cloudflare R2 and runs it directly. Subsequent launches start instantly from the local cache.

## Platform Support

- Windows x64
- macOS Apple Silicon (arm64)
- macOS Intel (x64)
- Linux x64
