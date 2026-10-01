# Cube local benchmarks

These scripts measure local Cube work, not provider response time, model quality,
TTFT, or LLM compaction. No additional dependencies are required.

```sh
pnpm bench:internal
pnpm bench:internal -- --quick
node --import tsx benchmarks/internal-latency.ts --json
pnpm bench:package
node benchmarks/package-benchmark.mjs --quick
node benchmarks/package-benchmark.mjs --json
pnpm bench:test
```

The internal benchmark runs source modules through the installed `tsx`. Build
packages with `pnpm build` first so workspace package imports are current.
`--quick` checks the benchmark with fewer samples; do not use its p95 for tuning.
JSON output can be saved for comparisons on the same machine, Node version,
fixtures and sampling settings. There are no machine-specific pass thresholds.
Use the direct `node` JSON commands above to avoid package-manager log headers.
Slow setup/package cases use fewer samples; their p95 is coarse, not a confidence
interval or a statistically established performance improvement.

## What is timed

| Operation | Boundary / fixture |
| --- | --- |
| `workspace.load` | Read + validate config/auth/catalog; load SOUL and project/global AGENTS; 100 catalog models |
| `skills.discover` | Fresh Cube/native registries discovering 16 project + 8 global skills |
| `skills.cached` | List the same registries, including their native refresh/path checks |
| `sqlite.init` | Construct + initialize a fresh file database, including native schemas |
| `sqlite.read.100` | Fetch/deserialize 100 persisted messages in order |
| `sqlite.checkpoint.write` | Persist a context checkpoint in thread metadata |
| `runtime.submit` | PromptService readiness → existing thread → history append → local dispatch boundary |
| `runtime.command` | Submit `/exit`, including history append and real command routing |
| `runtime.queue.cancel.100` | Cancel the newest of 100 queued follow-ups; retain FIFO ordering |
| `instructions.inject` | Format/inject loaded project/global AGENTS into a request |
| `skills.inject` | Native skill snapshot/read + real `$skill` processor enrichment |
| `context.estimate/prune` | Real text estimator and prune selector on 100/500 messages, 16 KiB per tool result |
| `context.frame/select` | Native source mapping and retained-history/summary-input selection; no summarizer call |
| `stream.reconcile` | Changing cumulative assistant output against 40/400 existing transcript rows |
| `render.cold` | Invalidate/render Markdown transcript at 80/120 columns |
| `render.cached` | Render unchanged transcript with its existing component caches |

The Session dispatch, gateway readiness, active thread and queue are benchmark-local
boundaries, not an end-to-end agent run. SQLite, stores, processors, context code
and transcript components are real. Render metrics exclude terminal painting,
keyboard/mouse handling and the full application layout.

Assertions, fixture creation, cleanup and verification reads are outside timing.
Each sample awaits its operation; very small CPU measurements include this
async harness overhead. Warmup precedes median/p95 sampling. `importsMs` is one
module-graph import observation, not an application-startup median.
`memoryBefore/After` are process snapshots, not per-operation allocations or leaks.
Fresh registries/databases do **not** mean cold OS disk caches.

## Packaging

Uses the existing native-host archive under `build/`; it does not build or release
anything. Override with `--archive=/absolute/path/to/archive`. Reports actual archive
bytes, unpacked bytes/file counts, extraction, CLI bundle syntax parsing in a fresh
packaged Node process, and the package's local smoke checks. The latter includes
module initialization/tools/templates/SQLite and is **not** pure CLI startup latency.
The main bundle starts the interactive app when executed/imported, so the syntax
metric uses `--check`, not a fake import measurement or an interactive UI test.

Extraction uses fresh temporary directories. The smoke process is preloaded with
the same network guard. Any failed extraction/import/smoke check fails the run;
there are no invented baseline values or improvement percentages. Older archives
measure their packaged code, not the current checkout; archive mtime is reported.

## Isolation

Only synthetic credentials, workspace files, skills and SQLite data under fresh
OS temporary directories are used. Existing `~/.cube` data is not read or changed.
The process-level guard rejects fetch, HTTP(S) and socket connections before Cube
imports; even a caught connection attempt makes the run fail. Package verification
starts child processes, so restricted environments may require permission to spawn.
