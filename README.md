# Mnemazine

Mnemazine turns screenshots, PDFs, links, and recordings into finished notes you can actually reuse later.

[Русский](README.ru.md)

[![License](https://img.shields.io/badge/license-community%201.0-blue.svg)](LICENSE) [![Stars](https://img.shields.io/github/stars/zarubinvibe/mnemazine?style=flat&color=C9A87A)](https://github.com/zarubinvibe/mnemazine/stargazers) [![Status](https://img.shields.io/badge/status-working-brightgreen.svg)](https://github.com/zarubinvibe/mnemazine) [![Olympuz](https://img.shields.io/badge/olympuz-family-B8D6EA.svg)](https://github.com/zarubinvibe/athena#olympuz-family)

<p align="center"><img src="docs/assets/pantheon/hero.png" alt="Mnemosyne in white marble beside the classical column, distilling raw fragments into a layered system of knowledge" width="100%"></p>

## Contents

- [What This Is](#what-this-is)
- [Why It Helps](#why-it-helps)
- [The Main Advantage](#the-main-advantage)
- [How It Works](#how-it-works)
- [Quickstart](#quickstart)
- [Simple Comparison](#simple-comparison)
- [Simple Words](#simple-words)
- [Safety And Privacy](#safety-and-privacy)
- [Limits](#limits)
- [Star And Contribute](#star-and-contribute)

<!-- beginner-readme:start -->

## What This Is

Mnemazine is a local knowledge refinery. Raw material goes into an inbox; finished notes come out into an Obsidian vault. Reading, recognition, and transcription happen on your machine, and a note is only stored once it has a source and a verdict.

## Why It Helps

Saved links and screenshots pile up and stay unread. The pile grows, the knowledge does not. Mnemazine reads that pile for you and leaves notes written for your future self, with the source attached and the duplicates merged.

## The Main Advantage

**Main advantage:** the heavy work happens locally, so a repeated file costs nothing.

**Why this is better:** Apple Vision recognition, parsing, transcription, and hashing run on your machine. A file that was already processed is recognised by its hash and never reaches a paid model again.

## How It Works

One run walks the whole pipeline. Every stage leaves evidence, and the run does not close while a file is still unaccounted for.

<!-- workflow-diagram:start -->

```text
  ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ Capture  │ ▶ │ Census   │ ▶ │ Extract  │
  └──────────┘   └──────────┘   └──────────┘
        ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ Verify   │ ▶ │ Refine   │ ▶ │ Store    │
  └──────────┘   └──────────┘   └──────────┘
        ▼
  ┌──────────┐
  │ Retrieve │
  └──────────┘
```

<!-- workflow-diagram:end -->

| Stage | What happens |
|---|---|
| 1. Capture | Screenshots, PDFs, links, notes, audio, video |
| 2. Census | A hash census, a vault snapshot, and a run lock |
| 3. Extract | Apple Vision OCR, document parsing, speech to text |
| 4. Verify | Primary source found, claims separated from guesses |
| 5. Refine | Long material is split into reusable atoms |
| 6. Store | Sections, links, indexes, and a coverage gate |
| 7. Retrieve | An HTML brief, a knowledge report, and graph queries |

### Step 1: Drop material into the inbox

You put files into one folder, or send them to your own Telegram bot. Nothing else is required from you.

**You get:** one inbox that holds everything waiting to be read.

### Step 2: The guard counts every file

Before anything is read, the guard takes a snapshot of the vault, locks the run, and hashes every incoming file. A hash already in the cache means the file is done.

**You get:** a ground-truth list that later stages cannot quietly shorten.

### Step 3: Local engines read it

Screens and photos go through Apple Vision, documents are parsed directly, and audio or video is transcribed locally. Interface noise and social chrome are dropped.

**You get:** clean content instead of a screenshot you would have to squint at.

### Step 4: Facts get a source

The material is treated as a seed, not as truth. The stage looks for the primary source, checks the claims that matter, and marks what could not be confirmed.

**You get:** a note you can cite, with its verification status visible.

### Step 5: One note per idea

A long guide becomes several focused notes, each with a plain title and a short section on how it helps you. Near-duplicates are found by meaning and merged instead of piling up.

**You get:** notes short enough that a future prompt pulls only the relevant one.

### Step 6: The note lands in the vault

Each note is filed into a life section, linked to its neighbours, and added to the indexes. Archiving the sources is only allowed after every input file is accounted for.

**You get:** an Obsidian vault that stays navigable as it grows.

### Step 7: Weekly brief and search

A weekly HTML brief shows what changed and what deserves action. A graph map lets an agent query the vault instead of loading all of it into context.

**You get:** knowledge that comes back to you instead of waiting to be remembered.

## Quickstart

You need Node.js 20 or newer, Python 3.11 or newer, and Git. macOS is recommended, because Apple Vision recognition is macOS only; on Linux everything else still runs.

```bash
git clone https://github.com/zarubinvibe/mnemazine.git "$HOME/Desktop/Mnemazine"
cd "$HOME/Desktop/Mnemazine"
bash setup.sh
bash install.sh
```

No Git? Download [the ZIP](https://github.com/zarubinvibe/mnemazine/archive/refs/heads/main.zip) or [the tarball](https://github.com/zarubinvibe/mnemazine/archive/refs/heads/main.tar.gz), unpack it, and run the same two scripts inside. `setup.sh` asks where the inbox goes; `MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh` previews it without touching anything.

**You get:** the folders are ready, the local engines report what is installed and what is degraded, and `vault/` opens as an Obsidian vault.

## Simple Comparison

| Choice | Best when | What you get | Trade-off |
|---|---|---|---|
| **Mnemazine** | The pile of saved material is already unreadable | Local reading, verified notes, deduplication, weekly brief | Best results need a Mac |
| Saving files into Obsidian yourself | You save a few items a week | Full control and no setup | Nothing is read, verified, or deduplicated for you |
| A cloud AI notebook | You want an answer about documents you upload | Fast questions and answers | Material leaves your machine and the notes stay inside that service |
| Reading it later by hand | The pile is small | Nothing to install | "Later" rarely arrives |

## Simple Words

| Word | Simple meaning |
|---|---|
| Repository | The project folder that Git stores and versions |
| Terminal | The window where you type commands |
| Command | One instruction you give the computer |
| Branch | A separate line of changes that does not touch `main` |
| Pull Request | A request to review your change and accept it |
| Vault | The folder of finished notes, opened by Obsidian |
| OCR | Turning a picture of text into text you can search |

## Safety And Privacy

- Local by default: recognition, parsing, transcription, and hashing run on your machine.
- Deep mode sends material to your chosen model provider only when you answer yes; with it off the run costs zero tokens.
- The Telegram bot is yours, not a shared one, and the system works the same without it.
- The bot token is stored with restrictive permissions and stays out of Git.
- Notes marked as personal data are refused by the export gate before anything leaves.
- Site and video parsing touch only the address you provided yourself.

The full channel-by-channel table, with the guard that holds each one, is in [the reference](docs/DETAILS.md).

## Limits

Status: working local system with a release check and honest exit codes.

- Apple Vision recognition is macOS only; on Linux screenshots fall back to the model or stay unread.
- Verification finds sources and contradictions, but the final judgement is still yours.
- A very large first run takes time and, in deep mode, tokens.
- The vault is plain Markdown: no hosted service keeps a backup for you.

Deeper reading: [the full reference](docs/DETAILS.md) covers ingestion of sites and video, the knowledge quality contract, the agent roster, exit codes, and troubleshooting.

## Star And Contribute

Useful? Give Mnemazine a star: [https://github.com/zarubinvibe/mnemazine](https://github.com/zarubinvibe/mnemazine). It takes a second and it decides whether other people ever find the project.

Want to change something? The path is short: fork the repository, create a branch, commit your change, push the branch, then open a Pull Request. Do not push directly to `main`; the release gate rejects it.

Found a problem instead? Open an issue at [https://github.com/zarubinvibe/mnemazine/issues](https://github.com/zarubinvibe/mnemazine/issues) and say what you ran and what happened.

<!-- beginner-readme:end -->

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

Mnemazine Community License 1.0: free for one person, including a solo business. An organisation needs a separate agreement. See [LICENSE](LICENSE).
