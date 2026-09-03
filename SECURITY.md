# Security

<p align="center"><img src="docs/assets/pantheon/doc-security.png" alt="Закрытый мраморный ларец под золотой печатью на столе, голубые нити от лотка входящих возвращаются в стопку готовых табличек, одна нить упирается в мраморную плиту границы" width="100%"></p>

## Where your material goes

Mnemazine is local-first, and that is a claim you can check rather than trust. Recognition of
screenshots, document parsing, speech transcription and hashing all run on your own machine. The
vault is a folder of plain Markdown files on your disk. Nothing is uploaded to us, because there is
no us: the project has no server, no account and no telemetry.

One thing can leave your machine, and only if you turn it on. When you enable an LLM provider,
the text of the material being processed is sent to that provider so it can be summarised or split
into notes. Local recognition and parsing happen first, so what travels is text you can read in the
extraction cache before it goes. Run without a provider and the pipeline still works, with the
local engines doing the reading.

## Reporting a problem

Report security issues privately through GitHub security advisories on this repository. Please do
not open a public issue for anything that exposes a key, a path or someone's private material.
If the advisory route is unavailable to you, open an issue that says only that you have a report
and how to reach you.

## Never publish

- API keys;
- OAuth tokens;
- SSH keys;
- browser cookies;
- private vault content;
- private screenshots;
- internal hostnames;
- personal absolute paths.

## The gate that checks it

Before a release, the project runs its own gate:

```bash
npm run release-check
```

It runs syntax checks, security self-tests, `npm audit`, and static scans for dangerous agent and
SSH flags and for credentials pasted into URLs. It also scans the local extraction cache for
token-shaped secrets, because a captured screenshot or a PDF can carry a credential that would
otherwise flow into a synthesised note. A captured secret fails the gate.
