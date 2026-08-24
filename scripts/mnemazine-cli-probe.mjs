#!/usr/bin/env node
// CLI availability probe with a CLOSED set of six outcomes. Ported concept from
// Фемида's cli_probe.py (замысел, not code): the probe answers a fixed enum so
// the caller decides by exit code alone (0 = ok), never by parsing prose.
//
//   ok · no_binary · no_auth · no_quota · no_write · timeout   ← ровно шесть
//
// Exit code is 0 ONLY on `ok`. Any other outcome exits 1 — the router does not
// have to read JSON to decide whether to route here.
//
// Refusals are cached under an inter-process lock so a dead CLI is not re-probed
// on every call. `no_quota` expires after 5h (quota heals itself; a permanent
// ban would cut a live CLI forever); every other refusal after 15 minutes. A
// revived CLI (probe now ok) is dropped from the cache immediately. The probe's
// environment is scrubbed of ambient tokens so it tests the CLI's own stored
// auth (keychain/config), not a transient env var.
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync, readFileSync, openSync, closeSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const OUTCOMES = ['ok', 'no_binary', 'no_auth', 'no_quota', 'no_write', 'timeout']
const QUOTA_RE = /quota|rate.?limit|too many requests|\b429\b|insufficient|billing|exceeded|out of (credit|token)/i
const DEFAULT_TIMEOUT_SEC = 45
const TTL_QUOTA_MS = 5 * 60 * 60 * 1000     // 5 hours
const TTL_OTHER_MS = 15 * 60 * 1000         // 15 minutes

// Ambient secrets never leak into the probe: it must exercise the CLI's durable
// auth, not whatever token happens to sit in this process's environment.
function cleanEnv() {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^ANTHROPIC_/i.test(key) || /^OPENAI_/i.test(key)) continue
    if (/_TOKEN$/i.test(key) || /_API_KEY$/i.test(key)) continue
    out[key] = value
  }
  return out
}

function ttlFor(outcome) {
  return outcome === 'no_quota' ? TTL_QUOTA_MS : TTL_OTHER_MS
}

// --- cache under an inter-process lock ---------------------------------------
function withCacheLock(cachePath, fn) {
  if (!cachePath) return fn(null) // no cache: run without lock, no persistence
  const lock = `${cachePath}.lock`
  const spin = new Int32Array(new SharedArrayBuffer(4))
  let held = false
  for (let attempt = 0; attempt < 100 && !held; attempt++) {
    try {
      closeSync(openSync(lock, 'wx'))
      held = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // Steal a stale lock (crashed holder) after 10s.
      try { if (Date.now() - statSync(lock).mtimeMs > 10000) { unlinkSync(lock); continue } } catch {}
      Atomics.wait(spin, 0, 0, 50)
    }
  }
  try {
    return fn(readCache(cachePath))
  } finally {
    if (held) { try { unlinkSync(lock) } catch {} }
  }
}

function readCache(cachePath) {
  try { return JSON.parse(readFileSync(cachePath, 'utf8')) } catch { return {} }
}

function writeCache(cachePath, data) {
  writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

// --- the probe itself --------------------------------------------------------
// Runs the probe command and maps the result onto exactly one outcome. Never
// throws for a normal failure — a failure is an outcome, not an exception.
export function probeCli({ cli, probeCmd, workdir, timeoutSec, cachePath, now }) {
  const nowMs = Number.isFinite(now) ? now : Date.now()
  if (!Array.isArray(probeCmd) || !probeCmd.length || !probeCmd.every(s => typeof s === 'string' && s)) {
    throw new Error(`${cli}: probe-cmd must be a non-empty list of non-empty strings`)
  }

  return withCacheLock(cachePath, cache => {
    // 1. A fresh cached refusal short-circuits — no spawn, no wasted CLI call.
    if (cache && cache[cli] && (nowMs - cache[cli].at) < ttlFor(cache[cli].outcome)) {
      return { cli, outcome: cache[cli].outcome, detail: cache[cli].detail || '', cached: true }
    }

    const result = runProbe(cli, probeCmd, workdir, timeoutSec)

    if (cache) {
      if (result.outcome === 'ok') delete cache[cli]                 // revived CLI leaves the cache at once
      else cache[cli] = { outcome: result.outcome, detail: result.detail, at: nowMs }
      writeCache(cachePath, cache)
    }
    return { ...result, cached: false }
  })
}

function runProbe(cli, probeCmd, workdir, timeoutSec) {
  // 2. Workdir must be writable — a CLI that cannot write its working dir is
  //    no_write, decided before we spend a spawn.
  const dir = workdir || os.tmpdir()
  const canary = path.join(dir, `.cli-probe-${process.pid}-${cli}`)
  try { writeFileSync(canary, 'x'); unlinkSync(canary) }
  catch { return { cli, outcome: 'no_write', detail: `workdir not writable: ${dir}` } }

  // 3. Spawn with scrubbed env and a hard timeout.
  const timeoutMs = Math.max(1, Number(timeoutSec || DEFAULT_TIMEOUT_SEC)) * 1000
  const res = spawnSync(probeCmd[0], probeCmd.slice(1), {
    cwd: dir, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs
  })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
  const tail = out.slice(-300)

  if (res.error?.code === 'ENOENT') return { cli, outcome: 'no_binary', detail: `binary not found: ${probeCmd[0]}` }
  if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') return { cli, outcome: 'timeout', detail: `no answer within ${timeoutSec || DEFAULT_TIMEOUT_SEC}s` }
  if (res.error) return { cli, outcome: 'no_auth', detail: String(res.error.message).slice(-300) }
  if (QUOTA_RE.test(out)) return { cli, outcome: 'no_quota', detail: tail }
  if (res.status !== 0) return { cli, outcome: 'no_auth', detail: `exit ${res.status}: ${tail}` }
  return { cli, outcome: 'ok', detail: '' }
}

// --- selftest ----------------------------------------------------------------
function selftest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`selftest: ${msg}`) }
  const tmp = os.tmpdir()

  assert(probeCli({ cli: 't', probeCmd: ['true'], workdir: tmp }).outcome === 'ok', 'true → ok')
  assert(probeCli({ cli: 'f', probeCmd: ['false'], workdir: tmp }).outcome === 'no_auth', 'false → no_auth')
  assert(probeCli({ cli: 'n', probeCmd: ['mnemazine-no-such-binary-9000'], workdir: tmp }).outcome === 'no_binary', 'missing → no_binary')
  assert(probeCli({ cli: 's', probeCmd: ['sh', '-c', 'sleep 3'], timeoutSec: 1, workdir: tmp }).outcome === 'timeout', 'sleep → timeout')
  assert(probeCli({ cli: 'q', probeCmd: ['sh', '-c', 'echo you exceeded your quota >&2; exit 1'], workdir: tmp }).outcome === 'no_quota', 'quota → no_quota')

  // no_write: a read-only workdir.
  const ro = path.join(tmp, `cli-probe-ro-${process.pid}`)
  spawnSync('mkdir', ['-p', ro]); spawnSync('chmod', ['500', ro])
  assert(probeCli({ cli: 'w', probeCmd: ['true'], workdir: ro }).outcome === 'no_write', 'ro workdir → no_write')
  spawnSync('chmod', ['700', ro]); spawnSync('rm', ['-rf', ro])

  // Cache: a refusal is remembered, then expires by --now, then a revived CLI is
  // dropped from the cache the moment it probes ok.
  const cache = path.join(tmp, `cli-probe-cache-${process.pid}.json`)
  try { unlinkSync(cache) } catch {}
  const t0 = 1_000_000_000_000
  assert(probeCli({ cli: 'z', probeCmd: ['false'], cachePath: cache, now: t0 }).outcome === 'no_auth', 'seed refusal')
  assert(probeCli({ cli: 'z', probeCmd: ['true'], cachePath: cache, now: t0 + 60_000 }).cached === true, 'fresh refusal cached (true probe not run)')
  const expired = probeCli({ cli: 'z', probeCmd: ['true'], cachePath: cache, now: t0 + TTL_OTHER_MS + 1 })
  assert(expired.cached === false && expired.outcome === 'ok', 'expired refusal re-probed → ok')
  assert(readCache(cache).z === undefined, 'revived CLI dropped from cache')
  // no_quota keeps its longer TTL.
  assert(probeCli({ cli: 'v', probeCmd: ['sh', '-c', 'echo rate limit >&2; exit 1'], cachePath: cache, now: t0 }).outcome === 'no_quota', 'seed quota')
  assert(probeCli({ cli: 'v', probeCmd: ['true'], cachePath: cache, now: t0 + TTL_OTHER_MS + 1 }).cached === true, 'quota still cached past 15min')
  try { unlinkSync(cache) } catch {}

  console.log(JSON.stringify({ ok: true, selftest: 'cli-probe', outcomes: OUTCOMES }))
  return 0
}

function main() {
  const { values } = parseArgs({
    options: {
      cli: { type: 'string' },
      'probe-cmd': { type: 'string' },
      workdir: { type: 'string' },
      timeout: { type: 'string' },
      cache: { type: 'string' },
      now: { type: 'string' },
      json: { type: 'boolean', default: false },
      selftest: { type: 'boolean', default: false }
    },
    allowPositionals: false
  })
  if (values.selftest) return selftest()
  if (!values.cli || !values['probe-cmd']) {
    console.error('usage: --cli <name> --probe-cmd <json-array> [--workdir d] [--timeout sec] [--cache f] [--now epochMs] [--json]')
    return 2
  }
  let probeCmd
  try { probeCmd = JSON.parse(values['probe-cmd']) } catch (e) { console.error(`--probe-cmd is not JSON: ${e.message}`); return 2 }

  let answer
  try {
    answer = probeCli({
      cli: values.cli,
      probeCmd,
      workdir: values.workdir,
      timeoutSec: values.timeout ? Number(values.timeout) : undefined,
      cachePath: values.cache,
      now: values.now ? Number(values.now) : undefined
    })
  } catch (e) {
    console.error(String(e.message || e))
    return 2
  }
  if (values.json) console.log(JSON.stringify(answer))
  else console.log(`${answer.cli}: ${answer.outcome}${answer.detail ? ` — ${answer.detail}` : ''}${answer.cached ? ' (cached)' : ''}`)
  return answer.outcome === 'ok' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
