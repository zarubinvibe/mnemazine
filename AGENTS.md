# Mnemazine Agent Commands

This repository has three chat commands. Treat them as commands, not as topics to discuss.

## `Mnemazine`

When the latest user message is `Mnemazine`, `Mnemazine inbox`, `Мнемозина`, or `запусти Мнемозину`:

```bash
npm start
```

Run it from the repository root. Do not use `npm run run` for live inbox work. `npm start` is the strict protocol: it must fail before archive if atomization/enrichment did not happen.

## `Mnemazine update`

When the latest user message is `Mnemazine update`, `Мнемозина update`, or `обнови Mnemazine`:

```bash
npm run update
```

This updates code from GitHub, preserves local config, reinstalls wrappers, and syntax-checks scripts. It must not process inbox files.

## `Mnemazine doctor`

When the latest user message is `Mnemazine doctor`, `Мнемозина doctor`, `проверь Mnemazine`, or `проверь Мнемозину`:

```bash
npm run doctor
```

This checks the last run, live vault gates, graph markers, release smoke, and inbox state. It must not process inbox files.

## Failure Rule

If a command fails, report the failing command and the key error. Do not archive, delete, reset, or rewrite user files.

## Skill Candidate Rule

If Mnemazine intake mentions a skill/capability with an upstream source, treat it as standing opt-in to run the safe install workflow. Do not leave it as a passive note.

Required path: read upstream README/SKILL/scripts, run `mcp-scan` or record why it is blocked, run local static/tests smoke, install only if review is clean, mirror to Claude/Codex/shared/VPS when applicable, and update shared registries/source ledgers/usage logs. Never pipe remote install scripts directly. If vetting fails, report the reason and do not install.


## Tool Vault Note Rule

When Mnemazine pipeline creates a synthesis note for a GitHub tool/repo — immediately also create a full standalone vault note. Do not leave synthesis-* as the only record.

Required path:

1. Fetch real README: `gh api repos/<owner>/<repo>/readme --jq '.content' | base64 -d`
2. Check stars: `gh api repos/<owner>/<repo> --jq '.stargazers_count, .license.spdx_id'`
3. Write `$MNEMAZINE_VAULT/01 Concepts/<kebab-slug>.md` — real README content, humanizer-ru Russian description, frontmatter with `status:"final" verified:true enrichment:"external-research"`
4. Add integration block: map tool to relevant owner projects from the vault project index — only where it genuinely fits
5. Append row to `$MNEMAZINE_VAULT/02 Projects/интеграции-новых-инструментов-в-проекты.md` with `🔲 план` status
6. Add to `~/.agents/GITHUB-STARS-LEDGER.md`
7. Archive the synthesis-* duplicate: move to `~/Архив/разобрано-ГГГГ-ММ/` with pointer note

If GitHub API unavailable or repo is private — write vault note from extracted content, mark `verified:false`.
