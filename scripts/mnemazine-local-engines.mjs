#!/usr/bin/env node
// Single source of truth about local extraction engines (rule 8). The five
// presence checks — vision-ocr, markitdown, whisper, ffmpeg, rg — live HERE and
// nowhere else: mnemazine-run.mjs and mnemazine-live-preflight.sh consume this
// module instead of re-encoding `command -v markitdown` in their own words.
//
// The point this module exists to serve (П10): distinguish «движка нет» from
// «движок ничего не нашёл». engineStatus() answers ONLY presence; a present
// engine that returns empty text is the caller's «не нашёл», not this module's
// «missing». That split is what lets the runner stop instead of silently
// reaching for the cloud.
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ROOT is resolved from the module's own location (so vision-ocr is found
// regardless of cwd), overridable by MNEMAZINE_ROOT to match the runner.
const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// kind: 'binary-path' → a file at a repo-relative path (survives PATH edits);
//       'path-command' → resolved via PATH exactly as spawnSync(cmd) would (execvp).
// required_for: which extraction purposes need this engine (documentation + report).
export const ENGINES = {
  'vision-ocr': { kind: 'binary-path', path: '.mnemazine/bin/vision-ocr', required_for: ['image', 'video-frames'] },
  markitdown:   { kind: 'path-command', probe: 'markitdown', required_for: ['pdf', 'docx', 'pptx', 'xlsx', 'html'] },
  whisper:      { kind: 'path-command', probe: 'whisper', required_for: ['video-audio'] },
  ffmpeg:       { kind: 'path-command', probe: 'ffmpeg', required_for: ['video'] },
  rg:           { kind: 'path-command', probe: 'rg', required_for: ['audit', 'search'] }
}

// Same resolution as spawnSync(cmd) with no shell: scan process PATH for an
// executable of that name. NOT a login shell — the runner spawns directly, so a
// login-shell-only PATH would over-report presence the runner can't actually use.
function onPath(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try { accessSync(path.join(dir, cmd), constants.X_OK); return true } catch { /* next dir */ }
  }
  return false
}

// 'present' | 'missing' — never a third value, never a throw for a known engine.
export function engineStatus(name) {
  const engine = ENGINES[name]
  if (!engine) throw new Error(`unknown local engine: ${name}`)
  if (engine.kind === 'binary-path') {
    try { accessSync(path.join(ROOT, engine.path), constants.X_OK); return 'present' } catch { return 'missing' }
  }
  return onPath(engine.probe) ? 'present' : 'missing'
}

// The subset of `list` that is missing. Empty array ⇒ every required engine is
// on hand. Callers gate on `.length`, never on presence-by-name in their own code.
export function requireEngines(list) {
  return list.filter(name => engineStatus(name) === 'missing')
}

// --- CLI: report / selftest ---------------------------------------------------
function report(asJson) {
  const rows = Object.keys(ENGINES).map(name => ({
    name, kind: ENGINES[name].kind, status: engineStatus(name), required_for: ENGINES[name].required_for
  }))
  if (asJson) console.log(JSON.stringify(rows))
  else for (const r of rows) console.log(`${r.status === 'present' ? 'ok' : 'fail'} ${r.name} ${r.status}`)
  return rows.every(r => r.status === 'present') ? 0 : 1
}

function selftest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`selftest: ${msg}`) }
  for (const name of Object.keys(ENGINES)) assert(['present', 'missing'].includes(engineStatus(name)), `${name} status enum`)
  let threw = false
  try { engineStatus('mnemazine-no-such-engine-9000') } catch { threw = true }
  assert(threw, 'unknown engine throws, never silent missing')
  const missing = requireEngines(Object.keys(ENGINES))
  assert(Array.isArray(missing) && missing.every(n => engineStatus(n) === 'missing'), 'requireEngines is the missing subset')
  console.log(JSON.stringify({ ok: true, selftest: 'local-engines', engines: Object.keys(ENGINES) }))
  return 0
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) return selftest()
  if (args.includes('--json')) return report(true)
  return report(false) // --report or bare
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
