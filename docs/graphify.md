# Graphify

🇬🇧 **English** · [🇷🇺 Русский](graphify.ru.md)

Install:

```bash
python3 -m pip install graphifyy
```

Update graph:

```bash
graphify update ~/Desktop/Mnemazine/vault
```

Guarded refresh for Mnemazine nightly/repair runs:

```bash
export MNEMAZINE_VAULT="/path/to/your/vault"
node scripts/mnemazine-refresh-graphify.mjs --vault "$MNEMAZINE_VAULT" --mode auto --json
```

Live inbox runs use code mode and start semantic extraction as a detached task:

```bash
npm run graph:semantic:async
npm run graph:semantic:monitor
npm run graph:semantic:status
npm run graph:semantic:status:pretty
npm run doctor:watch
```

Status includes `progress`: completed jobs, active shard, failed logs, and ETA.
Use `status:pretty` for the short human-readable view with PID and elapsed time.
Use `doctor:watch` when you want to wait until the detached task stops.
Shard runs are resume-able by default: successful shard outputs get `.done.json`
markers, and per-file semantic cache lives in `.mnemazine/semantic-cache`.
`graph:semantic:monitor` resumes pending/failed/dead tasks or stale
`needs_update` markers after `--stale-hours` / `MNEMAZINE_SEMANTIC_MONITOR_STALE_HOURS`.
Use `npm run graph:semantic:async -- --fresh`, `--no-resume`, or `--no-cache`
only for a deliberately clean rerun.

By default, async semantic refresh uses the local shard/swarm path. That avoids
one huge 1160-note Ollama extraction timing out. Force the old single-run path
only when needed:

```bash
MNEMAZINE_SEMANTIC_TASK_STRATEGY=full npm run graph:semantic:async
```

What helper does:

- runs code-safe `graphify update`;
- detects if semantic freshness is still pending;
- runs local semantic shards by default, then merges and re-clusters them;
- resumes completed shards and reuses per-file semantic cache;
- for local Ollama, normalizes base URL to `/v1` before OpenAI-compatible calls;
- smoke-tests candidate models with both chat JSON and mini `graphify extract` before heavy semantic extraction;
- walks a model ladder from `--models` / `MNEMAZINE_GRAPHIFY_MODELS`;
- makes backup of `graphify-out/`;
- restores backup and writes `graphify-out/needs_update` if semantic refresh looks unsafe;
- re-clusters report so `graph.json` and `GRAPH_REPORT.md` stay honest.

Exit codes:

- `0` = graph fresh;
- `2` = partial success, semantic refresh still pending;
- `1` = hard failure.

Defaults live in `config/graphify-refresh.json`.

API-backed semantic extraction:

```bash
OPENAI_API_KEY=... node scripts/mnemazine-refresh-graphify.mjs --backend openai --model gpt-4.1-mini --mode semantic --json
ANTHROPIC_API_KEY=... node scripts/mnemazine-refresh-graphify.mjs --backend claude --mode semantic --json
GEMINI_API_KEY=... node scripts/mnemazine-refresh-graphify.mjs --backend gemini --mode semantic --json
```

Do not commit API keys. The wrapper checks the required environment variable,
runs a mini `graphify extract` smoke test, backs up `graphify-out/`, and restores
the backup if semantic extraction fails or shrinks the graph unsafely.

Smoke test:

```bash
npm run graph:smoke
```

Graphify helps Mnemazine:

- find related notes;
- detect clusters;
- avoid duplicate concepts;
- build graph-aware context for agents.
