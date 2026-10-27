# Background Tasks

Run independent commands while the main conversation remains available.

<a id="running"></a>

## Run a Background Command

Ask Cube to run a command in the background when you can continue independent work. execute_command background:true returns a process_id after acceptance; it is not evidence that a build or test passed. Omitted/false background waits for the actual foreground result.

Completion or failure is delivered to the model in the owning thread. The model should not repeatedly poll manage_task just to wait. A long-lived dev server can use timeout:null on a background command and remains running until stopped or Cube exits.

Background command concurrency and deadlines are configured separately from subagent concurrency. Queued work waits for a slot. A returned process_id belongs to manage_task, not manage_subagent.

**config.yaml**

```yaml
background_tasks:
  enabled: true
  concurrency: 2
  timeout_ms: 300000
```

<a id="tasks"></a>

## /tasks & Live Logs

Use /tasks to search command tasks for the current thread. Enter opens the selected process's live log; k stops it. Arrow/PageUp/PageDown keys scroll logs, and Esc returns or closes. The footer shows the count of running commands; completed jobs drop out of the running count.

Task history is saved per thread, so reopening a thread can show past task records. A saved running record from another runtime is read-only/unattached, not proof that the OS process is still alive. Runtime-owned processes are stopped when you exit Cube.

<a id="output"></a>

## Output Continuation & Lifecycle

Large command output is written to temporary runtime-owned log files, with a bounded preview in the tool result/SQLite transcript. manage_task action:get can read preserved foreground or background output using the same process_id and cursor. Follow next_cursor only when more evidence is needed.

Full command logs are removed on runtime exit. A resumed thread retains its saved preview, not a promise to retrieve the full old process log. This is different from transcript pruning or model-context compaction.

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `background_tasks.enabled` | Boolean | `true` | Enable background command execution. It does not turn every foreground command into a background job. |
| `background_tasks.concurrency` | Integer: 1–32 | `2` | Maximum concurrently running background commands; additional commands wait in the queue. |
| `background_tasks.timeout_ms` | Integer: 0–600,000 | `300000` | Background command deadline in milliseconds. 0 disables it; execute_command timeout:null disables it for that background command. |
