# Mnemazine

🇬🇧 **English** · [🇷🇺 Русский](README.ru.md)

<p align="center">
  <img src="docs/assets/pantheon/hero.png" width="820" alt="Mnemazine — Mnemosyne, goddess of memory, beside her marble column, distilling raw fragments into a layered knowledge system">
  <br>
  <img src="docs/assets/pantheon/emblem.png" width="220" alt="Mnemazine emblem — Mnemosyne and the Pantheon column">
</p>

**Mnemazine** is a source-available personal memory system, named after **Mnemosyne**, the Greek goddess of memory and mother of the Muses.

The idea behind it is simple. Most people pile up notes, screenshots, and saved links and never look at them again. A pile is not memory. Real memory is what happens when you take something raw, understand it, check it, connect it to what you already know, and write down only the part worth keeping. Mnemazine does that part for you at the moment of saving.

The technique has a name, **synthesis on write**, popularized by [Andrej Karpathy](https://karpathy.ai/): don't dump and hope to read it later; distill the essence as you capture it, so the note is already useful the next time you open it.

In practice, Mnemazine takes screenshots, PDFs, web pages, YouTube videos, notes, guides, and GitHub repositories and turns them into a clean, [Obsidian](https://obsidian.md/)-compatible knowledge base. It extracts text locally first, keeps a source hash so you always know where a fact came from, stores only finished notes, links them into a graph, and refuses to let raw OCR or messy drafts leak into your vault.

> Memory, not a dump.

<p align="center">
  <img src="docs/assets/hero/mnemazine-synthesis.png" width="760" alt="Synthesis on write: many raw fragments are squeezed through to a single durable note">
</p>

## What It Is

Mnemazine is a local-first knowledge refinery. Material goes in raw; finished knowledge comes out.

It does not save raw OCR into your vault. It does not keep vague summaries that are impossible to reuse. It tries to produce finished knowledge:

- clear notes with understandable titles;
- source links and verification status;
- topic-based atomization when one source contains many ideas;
- reusable skill descriptions, agent instructions, implementation notes, and project actions;
- Graphify maps for semantic navigation;
- weekly HTML briefings with local state: `read`, `work on it`, `forget`.
- post-run visual knowledge reports: clusters, small atoms, duplicate accounting, and top-20 recommended actions.

The goal is simple: future you should not reread twenty screenshots, a whole guide, or a messy transcript. Future you should open one good note and immediately understand what the knowledge is, why it matters, how to use it, and what evidence supports it.

## How the Install Goes — You Won't Get Lost

This section sits right after "what it is" on purpose: before you run anything,
you should be able to picture the whole install.

`setup.sh` walks seven numbered stages, and each one finishes before the next
begins:

1. base environment: git and Node.js 20+ (a hard gate);
2. local recognition engines: python3, ffmpeg, whisper, swiftc (optional; a
   missing one prints the exact install command, never leaves you guessing);
3. where the inbox goes;
4. the LLM provider for deep mode;
5. the Telegram bot;
6. building the skeleton (`install.sh`);
7. done, with the exact next steps.

Four questions are real menus in the terminal, worded verbatim:

> Incoming material lands here: Desktop / inside the repo
>
> Providers found. Which one? (Claude CLI / Codex CLI / No deep — local parsing only)
>
> Connect a Telegram bot? (send it a file — it lands in the inbox)
>
> Do you have a VPS for the bot?

Where a capability is missing, the installer names the replacement instead of
failing: on a non-macOS device Apple Vision OCR is off and images are read by the
LLM. Nothing is silently skipped. Preview the whole thing without touching your
machine:

```bash
MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh
```

`install.sh` (the non-interactive path) asks once before it writes anything
outside the clone. No answer counts as no: it installs nothing and exits 1.
Bypass the prompt in automation with `MNEMAZINE_YES=1 bash install.sh`.

## Why It Saves Tokens

Mnemazine saves tokens by moving work out of repeated LLM context and into durable local structure: parse locally, cache aggressively, store refined atoms, retrieve narrowly.

<p align="center">
  <img src="docs/assets/hero/mnemazine-token.png" width="760" alt="Token economics: parse locally, hash cache, store atoms, retrieve narrowly">
</p>

Typical savings come from:

- **Local extraction first:** Apple Vision OCR, PDF parsing, transcription, hashing, and file census happen locally when possible.
- **Hash cache:** repeated files are detected before LLM processing. A duplicate costs zero model tokens.
- **Atomization:** one long guide can become twenty focused notes, so future prompts pull only the relevant atom.
- **Graphify context:** the agent can query a graph instead of dumping the whole vault into context.
- **Final notes only:** raw OCR and noisy transcripts stay outside the vault. The vault stores condensed, verified, human-readable knowledge.
- **Weekly briefs:** the system surfaces what changed and what deserves action, so the user does not ask the model to rediscover the week.

In real workflows, this often turns huge source piles into compact reusable notes. The exact savings depend on source size, but the operating principle is reliable: parse locally, cache aggressively, store refined atoms, retrieve narrowly.

## Install

Clone the project into the only folder you need:

```bash
git clone https://github.com/zarubinvibe/Mnemazine.git "$HOME/Desktop/Mnemazine"
cd "$HOME/Desktop/Mnemazine"
bash setup.sh        # guided, step-by-step (asks where the inbox goes, optional Telegram bot)
# or: bash install.sh   # non-interactive skeleton only
```

`setup.sh` walks a fresh device through setup in clear stages: it checks
prerequisites, tells you exactly what to install when something is missing,
asks where to put the `inbox/` (inside the repo or on the Desktop), and can
deploy the Telegram bot to a VPS. Preview a run without touching anything:
`MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh`.

`install.sh` installs Python packages from `requirements.lock` when the lock
exists. Update policy: edit `requirements.txt`, rebuild/freeze the lock in
`.venv`, then commit both files. Optional local engines print `DEGRADED: ...`
instead of pretending to be installed.

Update an existing clone:

```bash
cd "$HOME/Desktop/Mnemazine" && git pull --ff-only && bash install.sh
```

Agent chat update:

```text
Mnemazine update
```

After installation, open this folder as an Obsidian vault:

```text
$HOME/Desktop/Mnemazine/vault
```

The project lives under `$HOME/Desktop/Mnemazine` by default:

- `$HOME/Desktop/Mnemazine Inbox` for raw inputs when you choose the Desktop inbox in `setup.sh`;
- `inbox/` for repo-local raw inputs if you choose the repo inbox;
- `vault/` for finished knowledge;
- `reports/` for HTML weekly briefings;
- `.mnemazine/` for caches, binaries, and local state;
- `skills/`, `agents/`, `workflows/`, and `scripts/` for the agent system.

## Requirements

- macOS is recommended for Apple Vision OCR.
- Linux works for site parsing, markdown processing, Graphify, and vault operations, but Apple Vision OCR is skipped.
- Node.js 20+.
- Python 3.11+.
- Git.
- Optional: Obsidian, Claude Code, Codex, Cursor, OpenCode, Gemini CLI.

The installer checks what exists and installs what it can safely install locally. It does not require private credentials.

## One-Command Run

Put files into:

```text
$HOME/Desktop/Mnemazine Inbox
```

Open the project folder in your agent:

```text
$HOME/Desktop/Mnemazine
```

Then type one word in chat:

```text
Mnemazine
```

Terminal equivalent:

```bash
npm start
```

After `setup.sh`, this also works when `~/.local/bin` is in your `PATH`:

```bash
mnemazine
```

The run performs:

1. file census;
2. SHA-256 duplicate detection;
3. local extraction when possible;
4. deep atomization and source expansion;
5. final note creation with `source_ref` and `source_hash`;
6. vault quality gate;
7. archive move only after verified enriched atoms and quality gates pass;
8. guarded Graphify refresh attempt;
9. weekly HTML report regeneration;
10. report quality gate for the regenerated weekly HTML;
11. action brief at `.mnemazine/state/last-action-brief.md`;
12. visual post-run knowledge report in `reports/`.

Under `--deep` only, a final humanize stage rewrites notes into readable Russian and is held by a preservation gate: no number, URL, path, wikilink, code block, frontmatter, or `## Достоверность` line may be lost in the rewrite, or the run fails (`scripts/mnemazine-humanize-gate.mjs`; details in [docs/deep-mode.md](docs/deep-mode.md)). A non-deep run has no digest and no humanize gate — by decision, not accident.

`Mnemazine` / `npm start` is the safe default for real inbox work. The lower-level `npm run run` command is for development and demos.

To test the Desktop path without touching the live inbox or vault:

```bash
npm run protocol:desktop:dry-run
```

Before a real live run, run the preflight:

```bash
npm run preflight:live
```

It checks that tracked code is clean, `HEAD` matches `origin/main`, the LLM
provider is available, local security gates pass, the Desktop dry-run passes,
and the inbox has active files. If preflight fails, do not run `npm start`; fix
the cause first.

After a live run, inspect the result:

```bash
npm run last-run -- --require-ok
npm run complete -- --require-deep
```

Agent chat health check:

```text
Mnemazine doctor
```

Terminal equivalent:

```bash
npm run doctor
```

This does not process inbox files. It checks the last run, completion gate,
human layer, release smoke, graph markers, and inbox state.
If a semantic Graphify task is running, it also prints PID, elapsed time, and log path.
To wait until that task stops:

```bash
npm run doctor:watch
```

Override the polling delay with `-- --watch-interval-seconds 5`.

For a heavier vault-wide audit:

```bash
npm run doctor:full
```

This adds a full note human-layer pass and final-vault checks for raw intake
markers, private path filenames, nested Graphify runtime folders, and critical
broken wiki links. Use `npm run audit:vault -- --wiki-scope all --strict-wiki`
when you intentionally want every unresolved wiki link to fail.

To plan cleanup before editing links:

```bash
npm run wiki:links -- --vault "$MNEMAZINE_VAULT"
```

This writes `reports/YYYY-MM-DD-wiki-link-cleanup.{md,json}` with unresolved
wiki links grouped by section, target, and source file. It is read-only by
default. To apply the conservative repair plan, run:

```bash
npm run wiki:links -- --vault "$MNEMAZINE_VAULT" --apply
```

`--apply` removes placeholder/file/code-like wiki syntax and creates Russian
bridge notes for remaining missing targets. Follow with
`npm run audit:vault -- --vault "$MNEMAZINE_VAULT" --wiki-scope all --strict-wiki`.

If a strict run fails before archive, that is safe: source files stay in the
inbox. Do not move or delete them by hand. Read
`npm run last-run`, fix the cause, and run again.

## Website Ingestion

Mnemazine can ingest a website and convert its useful pages into structured notes:

```bash
node scripts/mnemazine-ingest-site.mjs --url https://example.com --apply --graphify --max-pages 40
```

The parser looks for:

- `robots.txt` sitemap hints;
- `sitemap.xml`;
- same-origin links;
- page titles, descriptions, headings, and main text;
- JSON-LD blocks;
- public API hints inside same-origin JavaScript;
- GitHub links and documentation links.

It does not use private cookies or browser sessions by default. If a site needs authentication, export the data yourself and place it in `inbox/`.

## YouTube Ingestion

Mnemazine can ingest a YouTube channel and turn every video into a transcript note, then keep pulling new uploads automatically:

```bash
python3 scripts/kb-yt-harvest.py "https://www.youtube.com/@SomeChannel" --all --subscribe
```

It pulls subtitles first (near-zero cost) and falls back to local whisper when a video has no usable captions. Each video becomes one inbox note named `yt_<date>_<id>_<title>.md`. A subscribed channel is then polled by `scripts/kb-yt-watch.py` over RSS, harvesting only new uploads, optionally on a daily launchd schedule.

It fetches public videos only and uses no cookies or account sessions by default. See [YouTube Ingestion](docs/youtube-ingestion.md).

## Knowledge Quality Contract

The vault must contain final knowledge, not raw material.

Every finished note should answer:

- What is this?
- Why does it matter?
- How can it be used?
- What are the source links?
- What is verified, assumed, or still unknown?
- Which skills, agents, scripts, or projects can reuse it?

Raw OCR, copied fragments, and messy transcripts are rejected by the quality gate.

The quality gate also rejects common raw-intake residue such as `intake-draft`, `draft-local`, `temp_image_*`, `IMG_*.PNG`, and visible raw image extensions in note content. Graphify output folders and backups are excluded from this note-quality scan.

`npm start` runs this gate only on notes changed during the current inbox run, so old legacy vault debt cannot block archive of newly processed files. Full vault audit stays manual.

Run the gate manually:

```bash
node scripts/mnemazine-vault-quality-gate.mjs
```

## Post-Run Knowledge Report

Every finished run can produce a light visual report in Markdown and HTML:

```bash
npm run postrun
```

The report is built for review, not raw logging. It shows:

- what useful knowledge appeared in the vault;
- how notes collapse into clusters and small reusable atoms;
- which duplicates were counted without creating junk notes;
- top-20 recommended actions after the batch.

When no explicit run JSON or logs are passed, the report reads recent vault notes. For exact pipeline runs, pass `--results-json` or `--logs`.

## Agent Skills

The repo includes portable Agent Skills in `.agents/skills` style:

- `skills/mnemazine`: the main knowledge refinery skill;
- `skills/local-doc-ops`: local document/PDF helpers.

The installer can copy them into common agent locations when those tools exist:

- `$HOME/.codex/skills`;
- `$HOME/.claude/skills`;
- project `.agents/skills`.

The skills are public-safe: no personal paths, no private repositories, no account names, no secrets.

## Claude And Codex Parity

Mnemazine is designed so Claude Code and Codex run the same knowledge contract:

- same public scripts in `scripts/`;
- same agent role descriptions in `agents/kb-pipeline/`;
- same `source_ref` / `source_hash` discipline;
- same quality gate before archive;
- same post-run visual report after each full pass.

Agent personalities are part of the workflow, not decoration. They are stored as public-safe role passports so both agents preserve the same responsibilities and tone while avoiding private data.

## Graphify

Graphify turns the vault into a navigable relationship graph. Mnemazine uses it for:

- related-note discovery;
- graph-assisted retrieval;
- weekly change maps;
- finding duplicate or near-duplicate ideas;
- showing how a source affects multiple knowledge areas.

For guarded local refreshes, use:

```bash
export MNEMAZINE_VAULT="/path/to/your/vault"
npm run graph:refresh -- --vault "$MNEMAZINE_VAULT" --mode auto
```

This wrapper keeps `graph.json`, `GRAPH_REPORT.md`, backup/restore, and `needs_update` in sync instead of blindly trusting one heavy semantic run.

Live `npm start` keeps Graphify fast: it refreshes the code graph, leaves a
`needs_update` marker, and starts semantic extraction as a detached task. Check it with:

```bash
npm run graph:semantic:async
npm run graph:semantic:monitor
npm run graph:semantic:status
```

For local Ollama semantic refreshes it also uses a guarded model ladder, rejecting models that fail a mini `graphify extract` smoke before they touch the real vault graph. API backends are supported through environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`.

The default shard path is resume-able: completed shards write `.done.json`, and per-file cache lives in `.mnemazine/semantic-cache`. `graph:semantic:monitor` safely resumes pending/failed/dead tasks or stale `needs_update` markers; it does not start a duplicate task while a PID is live. Use `npm run graph:semantic:async -- --fresh` for a clean rerun.

Repo defaults live in `config/graphify-refresh.json`. Override them with CLI flags or `MNEMAZINE_GRAPHIFY_*` env vars when needed.

Remote agent-os mirror uses an explicit allowlist in `config/athena-mirror-manifest.txt`. It is dry-run by default:

```bash
export MNEMAZINE_MIRROR_DEST="root@YOUR_VPS_HOST:/srv/agent-os/"
export MNEMAZINE_MIRROR_SSH_KEY="$HOME/.ssh/your_key"
export MNEMAZINE_MIRROR_KNOWN_HOSTS="$PWD/.mnemazine/known_hosts"
npm run mirror:agent-os
npm run mirror:agent-os:apply
```

The mirror stages payload first, scans it for token-like secrets, and refuses env files, secrets, sessions, caches, reports, and runtime state. `MNEMAZINE_MIRROR_KNOWN_HOSTS` enables strict host-key checking; without it, SSH uses your normal client defaults.

## Weekly HTML Brief

The weekly report is a local HTML presentation in Russian by default. It is meant to be pleasant to read, not a raw log.

Each card can be marked locally:

- `read`: keep in vault;
- `work`: move to action backlog;
- `forget`: remove or quarantine from the active vault.

State is stored in:

```text
$HOME/Desktop/Mnemazine/.mnemazine/state/weekly-state.json
```

## Repository Philosophy

Mnemazine is not a second brain as a storage slogan. It is a memory system as a pipeline:

```text
raw input -> extraction -> understanding -> research -> verification -> atomization -> vault -> graph -> reuse
```

<p align="center">
  <img src="docs/assets/hero/mnemazine-pipeline.png" width="820" alt="The Mnemazine pipeline: raw input, extract, verify, synthesize, vault, graph, reuse">
</p>

That matters because a real memory must be reproducible. A note should be able to become:

- a skill;
- an agent instruction;
- a script;
- a product decision;
- a checklist;
- a weekly action;
- a future prompt with much less context.

## My Agents

The run is a relay of small agents with fixed names: the names are part of the
contract, not decoration, so Claude and Codex keep the same roles and tone.

| Who | What they do | When |
|---|---|---|
| coordinator | orchestrates the run through its gates | every run |
| guard | git snapshot, run lock, SHA-256 census of the inbox | first, before anything |
| triage | splits the inbox into units of work | after the census |
| transcribe | local media → transcript (whisper) | video/audio, first |
| extract | pulls the core from one unit (OCR / markitdown) | per unit |
| verify | finds the source, fact-checks, enriches | per unit |
| classify | routes a unit to its vault section | verified unit |
| refine | cuts it into a finished note | classified unit |
| distribute | writes the note, wikilinks, merges duplicates | ready note |
| reconciler | census vs disk — every source is covered or explained | before archive |
| librarian | store, index, gated archive, and search | store / find |
| index | rebuilds indexes and writes the run log | end of run |

## Bot: Drop a File, It's in the Base

Send anything to your Telegram bot: text, photo, document, voice, audio, video,
and it lands in the Mnemazine `inbox/`. The install asks one question:

> Connect a Telegram bot? (send it a file — it lands in the inbox)

A bot wants to be always-on so it keeps receiving while your device sleeps, which
is what stage 5 of `setup.sh` sets up. There are three outcomes, each with its own
exit: a host is deployed, a local-only bot is printed for you to start by hand, or
the bot is skipped with zero consequences.

The bot is a transit buffer, not a second store: your machine pulls what arrived
and processes it locally; the finished knowledge lives only in your vault.

Lock the bot to yourself. On the first message it logs your `chat_id`; set
`ALLOWED_CHAT_IDS=<your_chat_id>` and restart. An empty allowlist rejects everyone
(fail-closed), so an unconfigured bot ignoring you is expected, not broken. Full
setup: [docs/telegram-intake.md](docs/telegram-intake.md).

## VPS: What It Does and Living Without It

The optional always-on host earns its keep with three things:

- round-the-clock intake while your Mac sleeps;
- network fetching: downloading a URL, snapshotting a source, an RSS radar,
  `yt-dlp`, pulling text out of HTML and PDF;
- corpus campaigns for the `text`, `public`, and `infra` data classes.

Three things stay on the Mac, because only a Mac can run them:

- Apple Vision OCR: a Swift binary at `.mnemazine/bin/vision-ocr`;
- `whisper` speech transcription;
- the `ollama` local model backend.

Promising to run those elsewhere would trade the free local tier for a cloud bill
on work that costs nothing today, so the installer never offers it.

What the host never sees: notes in the `pd` and `personal` data classes. The
class gate drops any such export with a non-zero code before it leaves the Mac.

Living without a host: answer "No VPS" at stage 5. The bot then runs locally while
your device is on (the exact command is printed), and everything else is unchanged.

## Privacy: What Leaves Your Computer

Named plainly, each with the guard that holds it, not a promise of good behavior.
Four channels can send data outward; every one is off or fenced by default.

| Channel | What leaves | What holds it |
|---|---|---|
| **deep mode** | the material's content goes to your chosen LLM provider | answer "No deep" at stage 4; with deep off it is zero tokens |
| **Telegram bot + VPS** | the bot token, everything you send the bot, and your whole local `reports/` | token under `umask 177` in `.mnemazine/config.env`, closed by `.gitignore`; the host is pinned by fingerprint (`known_hosts`, gitignored); remote state never changes without an explicit flag; and the data-class gate never lets `pd` or `personal` notes out |
| **site + YouTube parsing** | only the address you gave it yourself | nothing leaves until you give an address |
| **agent-os mirror** | only the files in the allowlist `config/athena-mirror-manifest.txt` | dry-run by default; env files, secrets, sessions, caches, reports, and runtime state are refused |

Always stays local: Apple Vision OCR, markitdown, whisper, hashing, and the corpus
itself. The boundary is simple: with the local engines present, parsing never
leaves the machine; without them, the LLM reads the file instead.

The bot is personal, not shared: it is your bot, not a common one, and without it
the system works exactly the same. Answering "No" to the bot question costs you
nothing else.

## Exit Codes

Every entry point returns an honest code you can branch on:

- `bash install.sh` — 0 ready, 2 ready with degraded capabilities, 1 not finished;
  and 1 if you decline the consent prompt (nothing is installed).
- `npm run doctor` — 0 all green, 2 no failures but warnings, 1 a failure or error.
  Every red line also prints the command that fixes it.
- `npm run release-check` — 1 on any failure; 2 when `--only` selects no known
  check (an empty selection is never reported as "passed 0/0").

## Something Broke — What to Do

Start with the short report of the last run:

```bash
npm run last-run
```

The full state of the last run is written to
`.mnemazine/state/last-action-brief.md`, and HTML reports land in `reports/`.
Then the health check, which reads the last run without processing anything:

```bash
npm run doctor
```

Every red line carries the exact command that fixes it. For a heavier, vault-wide
pass:

```bash
npm run doctor:full
```

If a strict run stopped before archive, that is by design: your source files are
still in the inbox. Do not move them by hand; fix the cause and run again.

## If You Improved Me

This is Philipp, the author. I built Mnemazine to turn raw input into verified,
ready-to-use knowledge, and I read every suggestion.

- If it helped, star it on GitHub; it genuinely matters:
  <https://github.com/zarubinvibe/Mnemazine>
- Got an idea to make it better? Open an issue or a PR. Contribution guidance is in
  [CONTRIBUTING.md](CONTRIBUTING.md); the security policy is in [SECURITY.md](SECURITY.md).

## Documentation

- [Installation](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Token Economics](docs/token-economics.md)
- [Website Ingestion](docs/site-ingestion.md)
- [YouTube Ingestion](docs/youtube-ingestion.md)
- [Telegram Intake (bot + Mini App)](docs/telegram-intake.md)
- [Obsidian Vault](docs/obsidian.md)
- [Apple Vision OCR](docs/apple-vision.md)
- [Graphify](docs/graphify.md)
- [Weekly HTML Brief](docs/weekly-html.md)
- [Deep Mode (atomization + verification)](docs/deep-mode.md)

## Safety

This public repository intentionally excludes:

- private vault contents;
- screenshots with personal data;
- API keys;
- SSH hosts;
- account names;
- private project names;
- local absolute paths from the original development machine.

Before publishing a release, run the full local gate:

```bash
npm run release-check
```

It checks script syntax, runs a temporary demo intake, verifies archive-after-quality behavior, runs the demo vault quality gate, scans for private markers/secrets, and checks that the public description and both READMEs stay bilingual.

For an offline local audit during development:

```bash
npm run audit:local
```

It runs syntax checks, security selftests, `npm audit`, `public-check`, and static scans for dangerous agent/SSH flags and credential-in-URL patterns.

## A Word From Mnemazine

I carry the name of the goddess of memory. In the myths she is the mother of the Muses — nothing gets
made without her, because nothing gets made out of nothing.

The man who built me is a lawyer from Kazan. Not a programmer: a founder with a legal practice, a
coffee business, two daughters, and no spare hours. He had thousands of screenshots, saved links and
notes he never opened again — and the honest realization that a pile is not memory. So he sat down
and wrote me, in the evenings, arguing with me more often than agreeing.

What I do is simple to say and tedious to do, which is why it is my job and not yours: I take the
material the moment it arrives, read it, look for where it actually came from, connect it to what you
already have, and keep only the part worth keeping. Raw text does not reach your vault. A claim I
could not confirm says so out loud instead of pretending. A year from now you open a note and see
immediately why it exists.

I am one of five, if you look closely. Athena keeps the workshop running, Themis argues cases,
Zeuz builds the machines, and Helioz refuses to let long work die overnight. Same marble, same
column, same refusal to accept a step on a promise.

Take me if you also collect and never return. Break me and say where — I would rather be corrected
than admired.

## The Same Marble

| Project | What it does |
|---|---|
| [Athena](https://github.com/zarubinvibe/athena) | A portable agent OS: brings a whole working setup up on a fresh Mac with one command. |
| [Helioz](https://github.com/zarubinvibe/helioz) | A conveyor that keeps work moving around the clock, so a long job survives sessions dying. |
| [Mnemazine](https://github.com/zarubinvibe/mnemazine) | Turns raw captures into verified, reusable notes and a linked local knowledge base. |
| [Themis](https://github.com/zarubinvibe/themis) | Multi-agent work on Russian court cases: thirteen lawyer-agents, a five-jurist council, local-first OCR. |
| [Zeuz](https://github.com/zarubinvibe/zeuz) | A factory for agent workflows: takes an idea and gives back a multi-agent system with its own constitution and gates. |

<!-- pantheon-family:start -->
## Olympuz family

This is one of the public [Olympuz projects](https://github.com/zarubinvibe/athena#olympuz-family). Each row opens the repository or downloads its source as a ZIP.

| Type | Name | What it does | Source |
|---|---|---|---|
| project | Athena | Portable agent OS that restores a complete Claude and Codex setup on a new Mac. | [Repository](https://github.com/zarubinvibe/athena) · [ZIP](https://github.com/zarubinvibe/athena/archive/refs/heads/main.zip) |
| project | Helioz | 24/7 agent work conveyor with verified completion markers and goal-based overnight decisions. | [Repository](https://github.com/zarubinvibe/helioz) · [ZIP](https://github.com/zarubinvibe/helioz/archive/refs/heads/main.zip) |
| project | Mnemazine | Local-first memory system that turns raw inputs into verified reusable knowledge. | [Repository](https://github.com/zarubinvibe/mnemazine) · [ZIP](https://github.com/zarubinvibe/mnemazine/archive/refs/heads/main.zip) |
| project | Themis | Multi-agent assistant for Russian litigation with local OCR and review by a five-jurist council. | [Repository](https://github.com/zarubinvibe/themis) · [ZIP](https://github.com/zarubinvibe/themis/archive/refs/heads/main.zip) |
| project | Zeuz | Factory that turns an idea into a governed multi-agent workflow with gates, observability, and replay. | [Repository](https://github.com/zarubinvibe/zeuz) · [ZIP](https://github.com/zarubinvibe/zeuz/archive/refs/heads/main.zip) |
<!-- pantheon-family:end -->

## License

Mnemazine Community License 1.0 (free for individual use; organizational use requires a separate agreement; see LICENSE).
