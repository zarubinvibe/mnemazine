# Installation

🇬🇧 **English** · [🇷🇺 Русский](installation.ru.md)

Install into one folder:

```bash
git clone https://github.com/zarubinvibe/Mnemazine.git "$HOME/Desktop/Mnemazine"
cd "$HOME/Desktop/Mnemazine"
bash install.sh
```

For the guided flow use:

```bash
bash setup.sh
```

Dry run:

```bash
MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh
```

The installer creates:

- `inbox/`;
- `vault/`;
- `reports/`;
- `.mnemazine/cache/`;
- `.mnemazine/state/`;
- `.mnemazine/bin/`.

Open `vault/` in Obsidian.

## macOS

On macOS, the installer tries to compile Apple Vision OCR:

```bash
swiftc -O skills/mnemazine/vision-ocr.swift -o .mnemazine/bin/vision-ocr
```

If this fails, install Xcode Command Line Tools:

```bash
xcode-select --install
```

## Python

Python dependencies are installed into `.venv/`. This keeps the system local to the Mnemazine folder.

`install.sh` uses `requirements.lock` when present, falling back to
`requirements.txt` only when the lock is absent. Update policy: change
`requirements.txt`, rebuild the local `.venv`, freeze to `requirements.lock`,
then commit both files. Set `MNEMAZINE_REQUIRE_PYTHON_DEPS=1` when Python
document engines must fail hard instead of degrading.

Missing optional engines are explicit: the installer prints `DEGRADED: ...` for
Python deps, Apple Vision OCR, or skipped local engines.

## Desktop Dry Run

```bash
npm run protocol:desktop:dry-run
```

This runs the Desktop protocol against temporary inbox/vault/cache/archive paths.
It never archives, deletes, or rewrites the live Desktop inbox.

## Live Preflight

```bash
npm run preflight:live
```

Before a real `npm start`, this checks that tracked code is clean, `HEAD`
matches `origin/main`, the LLM provider is available, the local security audit
passes, the Desktop dry-run passes, and the inbox has active files. Empty inbox,
dirty code, or a missing LLM provider is a failure. To test the command itself
without files, temporarily set `MNEMAZINE_PREFLIGHT_ALLOW_EMPTY=1`.

After a live run, inspect the result with:

```bash
npm run last-run -- --require-ok
```

## Agent Skills

If Codex or Claude skill folders exist, the installer copies portable skills there. If they do not exist, nothing breaks.
