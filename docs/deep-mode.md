# Deep Mode (atomization + verification)

Mnemazine has two operating modes:

- **Conservative (default):** local-only. No network, no LLM, no external services. This is what `node scripts/mnemazine-run.mjs` and `npm run synthesize` do by default.
- **Deep (opt-in):** uses an LLM agent (auto-select: Claude, otherwise Codex) to atomize one source into many focused notes (README "one source → ~20 notes") and to verify claims against their sources.

Deep mode is **off unless you ask for it**. Nothing in the default pipeline reaches the network or an LLM.

## Enabling deep mode

```bash
# real Desktop Inbox run, strict full protocol:
npm start
# after setup.sh, if ~/.local/bin is in PATH:
mnemazine

# whole run, deep:
node scripts/mnemazine-run.mjs --deep
# or via env (forwarded to synthesize):
MNEMAZINE_DEEP=1 node scripts/mnemazine-run.mjs

# synthesis only, deep:
npm run synthesize -- --deep
```

For live Desktop Inbox work, use `npm start` or `mnemazine`. It reads local config, enables deep mode, requires atomization + enrichment, and then runs the completion gate. The desktop completion gate checks notes changed during that run; use `npm run quality` for a full vault audit.

If deep mode is requested directly but no LLM engine is available, plain `node scripts/mnemazine-run.mjs --deep` falls back to local template synthesis and reports `degraded: true` in JSON. Strict runs (`--require-deep` or `npm start`) fail before archive.

## The LLM bridge

All LLM calls go through one module: `scripts/mnemazine-llm.mjs` (`llmJson(prompt, schema, {provider, tools})`). There is **no hard-coded list of engines**. The available CLIs live as data in `config/cli-registry.json` (base: `claude`, `codex`, `kimi`) plus the gitignored `config/cli-registry.local.json` overlay. Adding a CLI is one JSON entry and zero code edits. `scripts/mnemazine-cli-router.mjs` validates the registry, merges the overlay (which may add a CLI or tweak `model`/`effort`/`cost_tier`, but never repin a base CLI's `invoke`/`probe`/`data_classes`/`capabilities` or grant the `pd` class), and selects a CLI by data class → capability → cost tier → availability. The code branches on the declared **capability** of the chosen entry, never on a CLI name.

Each registry entry declares: `probe`/`invoke` (argv prefixes), `model`, `effort`, `data_classes`, `capabilities` (e.g. `json_schema_inline`, `json_schema_file`, `json_in_prompt`, `web_search`, `stdin_prompt`, `long_context`), `cost_tier` (`cheap|standard|premium`), and `local`. A stage that needs web search only routes to a `web_search` carrier; if none carries it the call fails with a named cause. Pin the engine with `MNEMAZINE_LLM=<registry-name>` (the owner's default is set in `.mnemazine/config.local.sh`).

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MNEMAZINE_LLM` | registry default | Pin a registry entry by name (e.g. `codex`, `claude`, `kimi`). Unset: the router picks from the registry, preferring an available binary. |
| `MNEMAZINE_<NAME>_BIN` | auto-discover | Override the binary for registry entry `<NAME>` (e.g. `MNEMAZINE_CLAUDE_BIN`, `MNEMAZINE_CODEX_BIN`). Resolved otherwise via env → login-shell PATH → known install paths → bare PATH. |
| `MNEMAZINE_LLM_TIMEOUT_MS` | `420000` | Per-call timeout. |
| `MNEMAZINE_DEEP` | unset | `1` enables deep mode (enrich + atomize + verify + digest). |
| `MNEMAZINE_ENRICH` | `1` within deep | `0` (or `--no-enrich`) skips the enrichment stage. |
| `MNEMAZINE_STRICT_ARCHIVE` | `1` in strict runs | `0` permits archiving with non-enriched notes. Default strict runs require verified enriched atoms. |
| `MNEMAZINE_MAX_ATOMS` | `20` | Cap on atoms produced per source cluster. |
| `MNEMAZINE_CONCURRENCY` | `4` | Swarm size for deep research (parallel agents, bounded). |
| `MNEMAZINE_OWNER_CONTEXT` | generic | Personal project context for the digest's "why it matters". Or put it in the gitignored `.mnemazine/owner-context.txt`. |

### Recognition (local-first, LLM fallback)

Extraction tries local engines first at **0 tokens**: Apple Vision OCR (images), markitdown (PDF/DOCX/PPTX/XLSX/HTML), whisper + frame OCR (video). Only when local yields nothing usable **and** `--deep` is on does a vision-capable LLM transcribe the file. Each file is isolated — one recognition failure logs an error, leaves the file in inbox, and never breaks the rest of the batch.

### Swarm

In deep mode, files/clusters are researched concurrently by a bounded pool of agents (`MNEMAZINE_CONCURRENCY`, default 4) — cheap and fast. A failing task never blocks the others.

### Enrichment (knowledge expansion)

Before atomization, deep mode runs a web-capable LLM agent that **researches and expands** the captured material "as much as is genuinely useful" — primary sources, current facts/versions, practitioner experience — with every added fact tied to a fetched URL (anti-hallucination). Atoms are then built from the **expanded** knowledge, not just the raw capture. Disable with `--no-enrich` / `MNEMAZINE_ENRICH=0`.

Strict runs (`npm start` / `--require-deep`) fail instead of archiving when enrichment or verification is missing. A cached OCR result is never enough.

### Digest (Russian human-readable summary)

After Graphify, `scripts/mnemazine-digest.mjs` (`npm run digest`) writes a humanizer-style Russian **Справка** into each note — *Что это / О чём / Почему важно мне / Связи* — plus one session summary note mapping all atoms. Connections (*Связи*) are derived directly from note metadata: atoms sharing a `cluster_id` (siblings from one source) and atoms sharing a source-URL host. Deterministic, no model key needed. (`graphify update` builds only the intra-note structural code-graph; richer note-to-note semantic links would need the separate `graphify --update` pass and are not relied upon here.) This is the reuse surface: open one note, understand the knowledge and how it connects. Idempotent (skips notes that already have a Справка unless `--force`).

### Humanize preservation gate (П13)

The digest rewrites/append prose, and rewriting loses facts. Two guards hold that with a non-zero exit code, not a prompt line:

- **Fact preservation, inside the digest.** Before each write, `scripts/mnemazine-digest.mjs` runs `preservationCheck` (from `scripts/mnemazine-humanize-gate.mjs`): every invariant of the old note — numbers, `http(s)://` URLs, paths/filenames, `[[wikilinks]]`, versions, ISO dates, latin tool-names, fenced/inline code, frontmatter, the whole `## Достоверность` block, number tables, quotes, and every spec heading — must survive into the new text (byte-exact for untouchable zones). A loss (e.g. the `--force` strip from the first `## Справка` to EOF nuking a later `## Достоверность`) means the file is **not** rewritten, the discrepancy is logged, and the digest exits non-zero — which fails the run.
- **Readability sweep, in the pipeline.** After the digest, `mnemazine-humanize-gate.mjs --sweep` scans notes changed this run. A run **fails** only on real AI-slop hard bans (`является`, `в современном мире`, `комплексный подход`, …). The em-dash `—` is pervasive in the corpus (95% of all hard bans — dates and titles) and a low cleanliness score are **advisory**, not fatal, so the watchdog never reds a live run on already-clean text. Score becomes fatal only under `MNEMAZINE_HUMANIZE_STRICT=1`.

**Deep-only, by decision not accident.** Both guards live inside the `if (DEEP)` block in `mnemazine-run.mjs` — a non-deep run has no digest and therefore no humanize gate. This is deliberate: humanizing is an LLM rewrite, and only deep runs invoke the LLM. `## Достоверность`, source quotes, and code are never compressed or "improved" — they are copied byte-for-byte.

The corpus campaign (`scripts/mnemazine-humanize-campaign.mjs`) applies the same gate note-by-note over existing notes, in git-committed batches of 50, worst-cleanliness first, and stops if three batches don't move the median. Baseline distribution lives in `.mnemazine/state/humanize-baseline.json` (`--baseline`).

### Atomization (G4)

`scripts/mnemazine-synthesize.mjs` (with `--deep`/`--atomize`) sends each source cluster to the LLM and asks for focused atoms — each with a title, what/why, how-to bullets, a next action, and the supporting source URLs. Each atom becomes its own note. Filenames are content-fingerprinted (scoped by cluster id) so re-runs are idempotent and never clobber an existing note.

### Verification (G5)

`scripts/mnemazine-verify.mjs` assigns each note a `verification_status`:

- `unknown` — no source URL anchored the claim;
- `assumed` — a source URL is present but was not fetched/checked (the **default local** verdict, zero network);
- `verified` — only under `--deep`: the source was reachable (HEAD/GET) **and** an LLM web cross-check judged it to support the claim. Such notes get `verified: true` and `status: final`.

In strict runs, only notes with `verified: true`, `verification_status: "verified"`, `enrichment: "external-research"`, public source URLs, and at least two recorded external facts can release an inbox file to archive.

## Security

### Untrusted input is fenced

Extracted material (OCR, transcripts, scraped web text) is **untrusted**. Before it is placed into any LLM prompt it is wrapped by `fenceUntrusted()` — an inert-data delimiter plus an explicit instruction that the content must never be executed as commands. Any literal occurrence of the fence sentinel inside the content is neutralized. This is the primary defense against prompt injection through captured material.

### Sandbox

The Claude backend runs `claude -p` without the permission-bypass flag; unpermitted tools simply do not run. The Codex backend runs headless with `--sandbox read-only`, `--ask-for-approval never`, and an ephemeral session. Web search is enabled only for deep calls that explicitly request web tools. The prompt-layer fencing above is still required, but the backend sandbox now matches the local-first boundary: inbox content can be analyzed, not executed.

### Data boundary

Deep verification (`--deep`) sends claim text and source URLs to the LLM agent, which performs web search — so locally-derived text reaches external search services **only under `--deep`**. The conservative default never does this.

### Local secret scan

`npm run release-check` (and `npm run public-check`) scan not only what could ship publicly but also the local extraction cache (`.mnemazine/cache/extracted/`) for token-like secrets (API keys, tokens, private keys), because captured screenshots or PDFs can contain credentials that would otherwise flow into synthesized notes. A captured secret fails the gate.
