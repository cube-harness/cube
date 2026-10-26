# Memory & Sessions

Persist conversations and reuse project knowledge across separate threads.

<a id="sessions"></a>

## SQLite Sessions, Resume & Fork

Conversations, tool records and context checkpoints are persisted in ~/.cube/memories/memory.sqlite. Local SQLite storage and its database ID/URL/path are owned by Cube; there is no memory.storage configuration block.

Use /resume (alias /threads) to reopen a conversation, /new to prepare a fresh one and /fork to branch the current conversation. Context compaction changes the model's view, not the stored transcript. Child transcripts use private thread/resource IDs in the same database rather than appearing as ordinary parent chats.

Thread titles are derived from the first prompt by default. Enabling generate_title runs an additional model call with its own model/instructions. It does not replace the coding agent's task instructions.

**config.yaml**

```yaml
memory:
  generate_title:
    enabled: false
    model: inherit
    # reasoning_effort: low
    instructions: Generate a concise title under 80 characters.
```

<a id="durable"></a>

## Durable Project Memory

Durable memory captures reusable project facts, evidence and lessons across threads. It is not the same as a compact summary, which only helps continue a particular conversation. Background extraction/consolidation can make additional LLM calls and consumes normal provider usage.

Memory lives under ~/.cube/memories, not a separate .MEMORY directory inside every project. MEMORY.md is the consolidated handbook; memory_summary.md is a short navigation/snapshot index; raw_memories.md stores extracted candidate material; rollout_summaries/`<thread-id>`.md stores per-conversation evidence and findings. Records carry project identity so one project's recall does not return another project's entries.

Eligible source conversations must be idle for min_idle_hours (default 6), with additional ownership/content checks. A brand-new tiny chat does not guarantee an extraction call. Existing Markdown memory is loaded into the project snapshot; /reload refreshes that snapshot when new committed memory becomes available.

Cube publishes memory atomically and retains evidence references to original SQLite messages. These Markdown files contain structured metadata: do not delete headers or add arbitrary prose outside the expected entry structure. Cube currently has no dedicated remember/update/delete tool for manual memory CRUD.

**config.yaml**

```yaml
memory:
  durable:
    enabled: true
    model: inherit
    # reasoning_effort: low
    min_idle_hours: 6
```

<a id="recall"></a>

## Recall & Evidence

memory_recall queries committed memory entries for the current project. Without embedding retrieval, it uses BM25 keyword relevance over structured Markdown sections. It does not require semantic_recall or the old observational-memory configuration.

Search results include bounded excerpts, source IDs, line ranges and evidence references. If an excerpt is insufficient, the model can read a returned source ID/range and its linked original-message evidence through memory_recall. It should use IDs supplied by search, not guess arbitrary file paths.

Recall is a tool: the model chooses when more past evidence is needed. The instruction snapshot is not an automatic injection of every historical prompt, and the embedding corpus is not the entire raw SQLite transcript.

<a id="retrieval"></a>

## Embeddings & Hybrid Retrieval

Enable memory.durable.retrieval with a concrete embedding model to combine BM25 with vector similarity. API embeddings use credentials from auth.json; local embeddings use the existing Ollama/LM Studio server settings. OAuth and inherit are not embedding-model strategies.

Cube embeds only the current project's committed handbook and rollout entries, not raw/index entries or the entire SQLite transcript. It chunks structured Markdown sections rather than embedding shared files indiscriminately. Enabling retrieval starts background indexing. With no usable current-profile chunks, search falls back to BM25; once batches are committed, those valid chunks can participate in hybrid search while remaining chunks continue indexing.

Memory edits re-embed only changed inputs; stale/deleted entries are filtered out. Changing the model ID or local endpoint automatically creates a new index generation for this project. Cube also invalidates indexes when its internal embedding policy changes. Vectors from different generations cannot be mixed. A provider silently replacing weights behind the same model ID cannot be detected from that ID alone.

Completed indexing batches survive /exit and can be resumed; the active indexing worker is stopped at shutdown. BM25 remains available if embeddings are interrupted or the provider fails. API indexing adds request cost; local indexing uses machine resources.

The retrieval fields control two separate operations: document embedding during indexing, and query embedding during memory_recall search. They do not configure the chat model or its reasoning effort.

| Setting | Practical effect |
| --- | --- |
| enabled | false uses BM25 without embedding calls; true enables background indexing and hybrid search when valid vectors are available. Durable memory must also be enabled. |
| model | Concrete embedding model, independent of the chat gateway/model. API credentials come from auth.json; local endpoints come from gateway_options. |

Cube owns the embedding policy, not config.yaml. It uses provider-default vector dimensions and preserves each Markdown section when it fits the input budget. Only oversized sections are split, with their heading/status retained in each fragment. The byte budget is conservative: native model input limits where available, known family limits otherwise, and a 2K fallback for unknown models, with a safety reserve. There is no universal tokenizer guarantee; rejected inputs fall back to BM25.

Task formatting is model-specific: Nomic uses search_document/search_query, standard E5 uses passage/query, supported Google embedding models use native retrieval task types, and Gemini Embedding 2 uses its text task format instead. Unknown models receive plain text, not guessed prefixes. Embedding errors do not block the chat turn.

This policy recognizes specific model IDs; it does not discover every model's required task instruction. Renamed local models and unsupported model families may not be recognized. Successful vector generation does not prove optimal retrieval quality; missing required task formatting can reduce quality without an API error. After editing retrieval.enabled/model or the local embedding endpoint in config.yaml, use /reload to apply the new retrieval profile; this does not change the chat model.

**config.yaml · Ollama Nomic example**

```yaml
memory:
  durable:
    enabled: true
    retrieval:
      enabled: true
      model: ollama/nomic-embed-text:latest
```

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `memory.generate_title.enabled` | Boolean | `false` | Enable an extra model call to generate a thread title. Otherwise Cube derives it from the first prompt. |
| `memory.generate_title.model` | Non-empty model ID or inherit | `inherit` | Model used only for title generation when enabled. |
| `memory.generate_title.reasoning_effort` | Optional effort enum | `Not set` | Override title-generation reasoning. Omitted: inherit parent options for model: inherit, otherwise use provider defaults. default suppresses parent-effort inheritance. |
| `memory.generate_title.instructions` | Non-empty string | `Generate a concise title under 80 characters.` | Instructions for the title generator, not the main coding agent. |
| `memory.durable.enabled` | Boolean | `true` | Enable background extraction and consolidation of durable project memory. These are separate model calls from compaction. |
| `memory.durable.model` | Non-empty model ID or inherit | `inherit` | Model for memory extraction/consolidation; inherit uses the main model rather than requiring another credential strategy. |
| `memory.durable.reasoning_effort` | Optional effort enum | `Not set` | Override extraction/consolidation reasoning. Omitted: inherit parent options for model: inherit, otherwise use provider defaults. default suppresses parent-effort inheritance. |
| `memory.durable.min_idle_hours` | Finite number: 0–720 | `6` | Minimum source-thread inactivity before memory extraction is eligible. 0 removes the age requirement; other safety/size checks still apply. |
| `memory.durable.retrieval.enabled` | Boolean | `false` | Enable embeddings/hybrid retrieval. BM25 remains the fallback when no usable index/chunks exist or embeddings fail; committed chunks can be searched while other chunks are indexing. |
| `memory.durable.retrieval.model` | Concrete provider/model or null | `null` | Required when retrieval is enabled. Use a supported API-key provider, ollama or lmstudio. OAuth and inherit are not embedding choices. |
