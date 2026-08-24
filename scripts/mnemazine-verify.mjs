#!/usr/bin/env node
// Hybrid verification for synthesized notes (README:160 "verified, assumed, or
// still unknown"). Default = local, zero-network structural gate. Deep = opt-in
// network: HEAD reachability + a codex web cross-check of the claim.
// ponytail: local gate is deliberately structural (no HEAD by default) so the
// conservative pipeline never reaches the network. Reachability+LLM only on --deep.
import dns from 'node:dns/promises'
import net from 'node:net'
import { llmAvailable, llmJson, fenceUntrusted } from './mnemazine-llm.mjs'

// Local gate: a source URL present means the claim is at least anchored
// ("assumed"); none means we cannot back it at all ("unknown"). Never claims
// "verified" — only a real source check earns that.
export function verifyLocal(urls = []) {
  const has = (urls || []).filter(Boolean).length > 0
  return { status: has ? 'assumed' : 'unknown', checked: [], note: has ? 'source url present, not fetched' : 'no source url' }
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'evidence', 'checked'],
  properties: {
    status: { type: 'string', enum: ['verified', 'assumed', 'unknown'] },
    evidence: { type: 'string' },
    checked: { type: 'array', items: { type: 'string' } }
  }
}

async function fetchWithTimeout(url, opts, timeoutMs, redirects = 3) {
  if (!await safeToFetch(url)) return null
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, redirect: 'manual', signal: ctrl.signal }).catch(() => null)
    if (redirects > 0 && res && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url).toString()
      return await fetchWithTimeout(next, opts, timeoutMs, redirects - 1)
    }
    return res
  } finally {
    clearTimeout(t)
  }
}

async function headOk(url, timeoutMs) {
  let res = await fetchWithTimeout(url, { method: 'HEAD' }, timeoutMs)
  // Some servers reject HEAD — fall back to a ranged GET with a FRESH timeout
  // (a shared aborted controller would otherwise kill the fallback instantly).
  if (!res || !res.ok) {
    res = await fetchWithTimeout(url, { method: 'GET', headers: { Range: 'bytes=0-0' } }, timeoutMs)
  }
  return !!res && res.ok
}

function privateIPv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
}

function privateIPv6(address) {
  const value = address.toLowerCase()
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return privateIPv4(mapped[1])
  return value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    value.startsWith('ff') ||
    value.startsWith('2001:db8:')
}

function privateAddress(address) {
  const cleaned = String(address || '').replace(/^\[|\]$/g, '')
  const kind = net.isIP(cleaned)
  if (kind === 4) return privateIPv4(cleaned)
  if (kind === 6) return privateIPv6(cleaned)
  return false
}

export function isPublicHttpUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false
  if (privateAddress(hostname)) return false
  return true
}

async function safeToFetch(url) {
  if (!isPublicHttpUrl(url)) return false
  const parsed = new URL(url)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (net.isIP(hostname)) return true
  try {
    const answers = await dns.lookup(hostname, { all: true, verbatim: true })
    return answers.length > 0 && answers.every(answer => !privateAddress(answer.address))
  } catch {
    return false
  }
}

// Deep gate: confirm reachability, then ask codex (with its own web search) to
// judge whether the listed sources actually support the claim. Degrades to the
// local verdict if codex is unavailable or errors.
export async function verifyDeep(claim, urls = [], options = {}) {
  const timeoutMs = options.timeoutMs || 8000
  const live = []
  const candidateUrls = (urls || []).filter(isPublicHttpUrl)
  if (options.assumeLiveUrls) {
    live.push(...candidateUrls)
  } else {
    for (const url of candidateUrls) {
      if (await headOk(url, timeoutMs)) live.push(url)
    }
  }
  if (!llmAvailable(options.provider)) {
    const local = verifyLocal(live)
    return { ...local, checked: live, note: `llm unavailable; reachable=${live.length}` }
  }
  try {
    const prompt = `Verify whether the SOURCES below support the CORE CLAIM. Use web search / fetch when needed. Return status:
- "verified" if an official source or primary source supports the main factual claim, even if wording differs.
- "assumed" if sources are only related or support only background context.
- "unknown" if no source supports it.

Be strict on numbers, rankings, benchmarks, funding, star counts, downloads, dates, and performance claims: those require direct support. For descriptive repository/product capability claims, an official GitHub repo or official docs page is enough if it supports the core claim.

${fenceUntrusted('CLAIM', String(claim).slice(0, 4000))}

SOURCES:
${live.length ? live.join('\n') : '(none reachable)'}`
    const res = await llmJson(prompt, VERIFY_SCHEMA, { timeoutMs: options.llmTimeoutMs, provider: options.provider, tools: ['WebSearch', 'WebFetch'], label: options.label || 'verify:claim' })
    let status = ['verified', 'assumed', 'unknown'].includes(res?.status) ? res.status : 'unknown'
    if (status === 'verified' && !live.length) status = 'unknown'
    const checked = Array.isArray(res?.checked) ? res.checked.filter(isPublicHttpUrl) : []
    return { status, checked: checked.length ? checked : live, evidence: res?.evidence || '', note: 'llm cross-check' }
  } catch (err) {
    const local = verifyLocal(live)
    return { ...local, checked: live, note: `deep verify failed: ${err.message}` }
  }
}

// Internal: exercise the codex cross-check path against MNEMAZINE_CODEX_BIN
// (used by --selftest with a stub bin; no real network/LLM). No reachable URL,
// so headOk yields [] and the verdict comes purely from the stubbed codex JSON.
if (process.argv.includes('--deep-once')) {
  const claim = process.env.MNEMAZINE_VERIFY_TEST_CLAIM || 'stub claim'
  const urls = String(process.env.MNEMAZINE_VERIFY_TEST_URLS || '').split(',').map(s => s.trim()).filter(Boolean)
  const assumeLiveUrls = process.env.MNEMAZINE_VERIFY_TEST_ASSUME_LIVE === '1'
  const verdict = await verifyDeep(claim, urls, { llmTimeoutMs: 10000, assumeLiveUrls })
  console.log(JSON.stringify(verdict))
  process.exit(0)
}

// Self-check: run `node scripts/mnemazine-verify.mjs --selftest`
if (process.argv.includes('--selftest')) {
  const a = verifyLocal(['https://x.test'])
  const b = verifyLocal([])
  if (a.status !== 'assumed') throw new Error('expected assumed for url present')
  if (b.status !== 'unknown') throw new Error('expected unknown for no url')
  if (isPublicHttpUrl('http://127.0.0.1/')) throw new Error('loopback URL passed public URL gate')
  if (isPublicHttpUrl('http://169.254.169.254/latest/meta-data/')) throw new Error('link-local URL passed public URL gate')
  if (await headOk('http://127.0.0.1/', 50)) throw new Error('loopback URL passed fetch gate')

  // Deep path with a stub codex bin (provider=codex): confirm llmJson round-trips
  // and the status enum is honoured end-to-end. Claude backend shares the same
  // contract; live Claude needs one real run to confirm (unproven in CI).
  const { promises: fsp } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mnemazine-verify-selftest-'))
  const bin = path.join(dir, 'fakecodex')
  await fsp.writeFile(bin, `#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { out="$2"; shift; }; shift; done
cat >/dev/null
status="\${FAKE_CODEX_STATUS:-verified}"
printf '{"status":"%s","evidence":"stub confirms","checked":["https://e.test"]}' "$status" > "$out"
`, { mode: 0o755 })
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--deep-once'], {
    env: { ...process.env, MNEMAZINE_LLM: 'codex', MNEMAZINE_CODEX_BIN: bin, MNEMAZINE_VERIFY_TEST_ASSUME_LIVE: '1', MNEMAZINE_VERIFY_TEST_URLS: 'https://e.test' }, encoding: 'utf8'
  })
  if (res.status !== 0) throw new Error(`deep-once failed: ${res.stderr}`)
  const verdict = JSON.parse(res.stdout)
  if (verdict.status !== 'verified') throw new Error(`expected verified from stub codex, got ${verdict.status}`)
  const assumed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--deep-once'], {
    env: {
      ...process.env,
      MNEMAZINE_LLM: 'codex',
      MNEMAZINE_CODEX_BIN: bin,
      MNEMAZINE_VERIFY_TEST_ASSUME_LIVE: '1',
      MNEMAZINE_VERIFY_TEST_URLS: 'https://github.com/microsoft/markitdown',
      MNEMAZINE_VERIFY_TEST_CLAIM: 'MarkItDown is maintained by Microsoft and has unsupported extra benchmark claims.',
      FAKE_CODEX_STATUS: 'assumed'
    },
    encoding: 'utf8'
  })
  await fsp.rm(dir, { recursive: true, force: true })
  if (assumed.status !== 0) throw new Error(`deep-once assumed failed: ${assumed.stderr}`)
  const assumedVerdict = JSON.parse(assumed.stdout)
  if (assumedVerdict.status !== 'assumed') throw new Error(`expected assumed to stay assumed, got ${assumedVerdict.status}`)

  console.log('verify selftest ok')
}
