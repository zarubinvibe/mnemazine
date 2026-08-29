#!/usr/bin/env node
// Mnemazine Telegram Mini App backend. Localhost HTTP API behind nginx TLS.
// Endpoints (all require valid Telegram WebApp initData for an allowed user):
//   GET  /api/status  -> { count, recent:[{name,at}], lastRun }
//   POST /api/send    {text} -> writes a note into the inbox
//   POST /api/run     -> touches .run-now flag; Mac poller picks it up
// Native http + crypto only, zero deps.
//
// Env: TELEGRAM_BOT_TOKEN (required), MNEMAZINE_INBOX, ALLOWED_CHAT_IDS, PORT (8787)

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const SELFTEST = process.argv.includes('--selftest')
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN && !SELFTEST) { console.error('FATAL: TELEGRAM_BOT_TOKEN not set'); process.exit(1) }
const INBOX = path.resolve(process.env.MNEMAZINE_INBOX || path.join(process.cwd(), 'inbox'))
const RUN_FLAG = path.join(INBOX, '.run-now')
const RUN_MARKER = path.join(INBOX, '.last-run')
const SEARCH_QUEUE = path.join(INBOX, '.search-queue')
// Reports are produced on the Mac (vault is local there) and rsynced here.
const REPORTS = path.resolve(process.env.MNEMAZINE_REPORTS || path.join(process.cwd(), 'reports'))
const PORT = Number(process.env.PORT || 8787)
const ALLOWED = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
const throttle = new Map() // user.id -> last write ms

// Verify Telegram WebApp initData. Returns the user object or null.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, token) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null
  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest()
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
  // timing-safe compare
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null
  // Reject stale initData — a leaked/captured one must not work forever (replay).
  const ttl = Number(process.env.MNEMAZINE_INITDATA_TTL || 86400)
  if (ttl > 0) {
    const authDate = Number(params.get('auth_date'))
    if (!authDate || (Date.now() / 1000) - authDate > ttl) return null
  }
  try { return JSON.parse(params.get('user') || 'null') } catch { return null }
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const MAX_BODY = 65536 // 64 KB — notes are small; cap guards against OOM.
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > MAX_BODY) { const e = new Error('payload too large'); e.code = 413; throw e }
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function status() {
  const names = (await fs.readdir(INBOX).catch(() => [])).filter(n => !n.startsWith('.'))
  const recent = []
  for (const n of names.slice(-10).reverse()) {
    const st = await fs.stat(path.join(INBOX, n)).catch(() => null)
    if (st) recent.push({ name: n, at: st.mtime.toISOString() })
  }
  const lastRun = await fs.readFile(RUN_MARKER, 'utf8').catch(() => null)
  return { count: names.length, recent, lastRun: lastRun?.trim() || null }
}

async function send(text) {
  await fs.mkdir(INBOX, { recursive: true })
  const stamp = new Date().toISOString()
  const day = stamp.slice(0, 10)
  const body = ['---', 'source: telegram-webapp', `date: ${stamp}`, '---', '', text, ''].join('\n')
  const name = `tg_${day}_webapp_${Date.now()}.md`
  await fs.writeFile(path.join(INBOX, name), body, 'utf8')
  return name
}

// Queue a topic search. Vault lives on the Mac, so the VPS can only enqueue;
// the Mac poller drains this, runs the swarm, and rsyncs reports back here.
async function queueSearch(topic, user) {
  await fs.mkdir(INBOX, { recursive: true })
  const line = JSON.stringify({ topic, by: user, at: new Date().toISOString() }) + '\n'
  await fs.appendFile(SEARCH_QUEUE, line, 'utf8')
}

async function listReports() {
  const names = (await fs.readdir(REPORTS).catch(() => [])).filter(n => n.endsWith('.md'))
  const out = []
  for (const n of names.sort().reverse().slice(0, 20)) {
    const st = await fs.stat(path.join(REPORTS, n)).catch(() => null)
    if (st) out.push({ name: n, at: st.mtime.toISOString() })
  }
  return out
}

async function readReport(name) {
  // Path-escape guard: only a bare *.md filename inside REPORTS, no traversal.
  if (!name || name !== path.basename(name) || !name.endsWith('.md')) return null
  const full = path.join(REPORTS, name)
  if (path.dirname(full) !== REPORTS) return null
  return fs.readFile(full, 'utf8').catch(() => null)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })

    const initData = req.headers['x-telegram-initdata'] || ''
    const user = verifyInitData(String(initData), TOKEN)
    if (!user) return json(res, 401, { error: 'bad initData' })
    if (ALLOWED.length && !ALLOWED.includes(String(user.id))) return json(res, 403, { error: 'forbidden' })

    // Structured access log (stderr): who hit what, for audit.
    console.error(JSON.stringify({ ts: new Date().toISOString(), user: user.id, method: req.method, path: url.pathname }))

    // Light per-user throttle on writes (1/sec) — coarse anti-flood, not a quota.
    if (req.method === 'POST') {
      const last = throttle.get(user.id) || 0
      const now = Date.now()
      if (now - last < 1000) return json(res, 429, { error: 'slow down' })
      throttle.set(user.id, now)
    }

    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status())
    if (req.method === 'GET' && url.pathname === '/api/searches') return json(res, 200, { reports: await listReports() })
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const md = await readReport(url.searchParams.get('name') || '')
      if (md == null) return json(res, 404, { error: 'not found' })
      return json(res, 200, { markdown: md })
    }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      const { topic } = JSON.parse(await readBody(req) || '{}')
      if (!topic || !topic.trim() || topic.length > 500) return json(res, 400, { error: 'bad topic' })
      await queueSearch(topic.trim(), user.id)
      return json(res, 200, { ok: true, queued: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const { text } = JSON.parse(await readBody(req) || '{}')
      if (!text || !text.trim()) return json(res, 400, { error: 'empty text' })
      return json(res, 200, { ok: true, saved: await send(text.trim()) })
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      await fs.mkdir(INBOX, { recursive: true })
      // Coalescing trigger (many taps → one run) with a who/when audit trail.
      // ponytail: a flag, not a job queue — single user, single button.
      await fs.writeFile(RUN_FLAG, JSON.stringify({ at: new Date().toISOString(), by: user.id }), 'utf8')
      return json(res, 200, { ok: true, queued: true })
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    if (e.code === 413) return json(res, 413, { error: 'payload too large' })
    console.error(`[500] ${e.stack || e.message}`)   // detail to stderr, not the client
    return json(res, 500, { error: 'internal error' })
  }
})

async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`selftest: ${m}`) }
  // build a valid initData and verify round-trips; tampered fails.
  const tok = 'test:token'
  const user = JSON.stringify({ id: 1, first_name: 'F' })
  const sign = params => {
    const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
    const secret = crypto.createHmac('sha256', 'WebAppData').update(tok).digest()
    return crypto.createHmac('sha256', secret).update(dcs).digest('hex')
  }
  const fresh = String(Math.floor(Date.now() / 1000))
  const p = new URLSearchParams({ auth_date: fresh, user }); p.set('hash', sign(new URLSearchParams({ auth_date: fresh, user })))
  const ok = verifyInitData(p.toString(), tok)
  assert(ok && ok.id === 1, 'valid fresh initData accepted')
  assert(verifyInitData(p.toString(), 'wrong:token') === null, 'wrong token rejected')
  const bad = new URLSearchParams(p); bad.set('auth_date', String(Number(fresh) + 1))
  assert(verifyInitData(bad.toString(), tok) === null, 'tampered payload rejected')
  assert(verifyInitData('', tok) === null, 'empty rejected')
  // C7: test from the threat — a correctly-signed but OLD initData must be refused.
  const staleDate = String(Math.floor(Date.now() / 1000) - 100000)
  const stale = new URLSearchParams({ auth_date: staleDate, user }); stale.set('hash', sign(new URLSearchParams({ auth_date: staleDate, user })))
  assert(verifyInitData(stale.toString(), tok) === null, 'stale (replay) initData rejected')
  console.log('selftest ok')
}

if (SELFTEST) selftest().catch(e => { console.error(e.message); process.exit(1) })
else server.listen(PORT, '127.0.0.1', () => console.log(`Mnemazine webapp API on 127.0.0.1:${PORT} inbox=${INBOX} allow=${ALLOWED.join(',') || 'ANY'}`))
