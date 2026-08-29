#!/usr/bin/env node
// Mnemazine Telegram intake bot.
// Long-polls getUpdates, writes each message into a staging inbox dir as a
// file the Mnemazine protocol can pick up. Native fetch only, zero deps.
//
// Env:
//   TELEGRAM_BOT_TOKEN   (required) bot token from @BotFather
//   MNEMAZINE_INBOX      (optional) target dir, default ./inbox
//   ALLOWED_CHAT_IDS     (optional) comma-separated chat ids; if set, others ignored
//
// On a host (VPS) it runs under pm2; the Mac pulls the staging dir daily.
// ponytail: long-poll, not webhook — no TLS/public-port setup, Telegram buffers ~24h.

import fs from 'node:fs/promises'
import path from 'node:path'

const SELFTEST = process.argv.includes('--selftest')
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN && !SELFTEST) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN not set')
  process.exit(1)
}
const API = `https://api.telegram.org/bot${TOKEN}`
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`
let INBOX = path.resolve(process.env.MNEMAZINE_INBOX || path.join(process.cwd(), 'inbox'))
const OFFSET_FILE = path.join(INBOX, '.telegram-offset')
const ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const api = async (method, params) => {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`${method}: ${json.description}`)
  return json.result
}

const sanitize = name => (name || 'file').replace(/[^\w.\-а-яёА-ЯЁ]+/gu, '_').slice(0, 80)

async function downloadFile(fileId, suggestedName) {
  const f = await api('getFile', { file_id: fileId })
  const url = `${FILE_API}/${f.file_path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${fileId}: HTTP ${res.status}`)
  // Cap download size to avoid OOM on a hostile/huge file (Telegram tops ~20 MB).
  const MAX_FILE = 30 * 1024 * 1024
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_FILE) throw new Error(`download ${fileId}: too large (${len} bytes)`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_FILE) throw new Error(`download ${fileId}: too large (${buf.length} bytes)`)
  const rawExt = path.extname(f.file_path) || path.extname(suggestedName || '') || ''
  const ext = rawExt.replace(/[^.\w]/g, '').slice(0, 12) // no path separators / traversal

  const base = suggestedName ? sanitize(path.basename(suggestedName, path.extname(suggestedName))) : sanitize(path.basename(f.file_path, ext))
  const stamp = new Date().toISOString().slice(0, 10)
  const target = path.join(INBOX, `tg_${stamp}_${base}${ext}`)
  await fs.writeFile(target, buf)
  return path.basename(target)
}

async function writeText(msg, text) {
  const stamp = new Date().toISOString().slice(0, 10)
  const from = msg.from?.username || msg.from?.first_name || msg.chat?.id
  const body = [
    '---',
    `source: telegram`,
    `from: ${from}`,
    `chat_id: ${msg.chat?.id}`,
    `date: ${new Date((msg.date || 0) * 1000).toISOString()}`,
    '---',
    '',
    text,
    '',
  ].join('\n')
  const target = path.join(INBOX, `tg_${stamp}_${msg.message_id}.md`)
  await fs.writeFile(target, body, 'utf8')
  return path.basename(target)
}

async function handle(msg) {
  const chatId = String(msg.chat?.id ?? '')
  console.log(`[msg] chat_id=${chatId} from=${msg.from?.username || msg.from?.first_name || '?'}`)
  // Fail-closed: an empty allowlist rejects everyone (still logs the id so you
  // can configure it), rather than accepting any stranger who finds the bot.
  if (!ALLOWED.length) {
    console.log(`[reject] ALLOWED_CHAT_IDS empty — set it to "${chatId}" then restart to accept`)
    return
  }
  if (!ALLOWED.includes(chatId)) {
    console.log(`[skip] chat_id ${chatId} not in ALLOWED_CHAT_IDS`)
    return
  }

  const saved = []
  if (msg.photo?.length) saved.push(await downloadFile(msg.photo[msg.photo.length - 1].file_id))
  if (msg.document) saved.push(await downloadFile(msg.document.file_id, msg.document.file_name))
  if (msg.voice) saved.push(await downloadFile(msg.voice.file_id, `voice_${msg.message_id}.ogg`))
  if (msg.audio) saved.push(await downloadFile(msg.audio.file_id, msg.audio.file_name || `audio_${msg.message_id}.mp3`))
  if (msg.video) saved.push(await downloadFile(msg.video.file_id, `video_${msg.message_id}.mp4`))
  if (msg.video_note) saved.push(await downloadFile(msg.video_note.file_id, `videonote_${msg.message_id}.mp4`))

  const text = msg.text || msg.caption
  if (text) saved.push(await writeText(msg, text))

  if (!saved.length) console.log('[skip] no usable content (sticker/location/etc)')
  else { console.log(`[saved] ${saved.join(', ')}`); try { await api('sendMessage', { chat_id: chatId, text: `✓ в inbox: ${saved.length}` }) } catch {} }
}

async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`selftest: ${m}`) }
  assert(sanitize('a/b c?.PNG') === 'a_b_c_.PNG', `sanitize got "${sanitize('a/b c?.PNG')}"`)
  assert(sanitize('Файл №1.pdf') === 'Файл_1.pdf', `cyrillic got "${sanitize('Файл №1.pdf')}"`)
  assert(sanitize('') === 'file', 'empty name fallback')
  const tmp = path.join(process.cwd(), '.mnemazine', 'tg-selftest')
  await fs.mkdir(tmp, { recursive: true })
  const orig = INBOX; INBOX = tmp
  const name = await writeText({ message_id: 7, chat: { id: 42 }, from: { username: 'u' }, date: 0 }, 'hello')
  const written = await fs.readFile(path.join(tmp, name), 'utf8')
  INBOX = orig
  assert(written.includes('source: telegram') && written.includes('hello'), 'writeText frontmatter/body')
  await fs.rm(tmp, { recursive: true, force: true })
  console.log('selftest ok')
}

async function loadOffset() {
  try { return Number(await fs.readFile(OFFSET_FILE, 'utf8')) || 0 } catch { return 0 }
}

async function main() {
  await fs.mkdir(INBOX, { recursive: true })
  let offset = await loadOffset()
  console.log(`Mnemazine TG bot up. inbox=${INBOX} allowlist=${ALLOWED.length ? ALLOWED.join(',') : 'OPEN(bootstrap)'}`)
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] })
      for (const u of updates) {
        if (u.message) {
          // At-least-once: only advance/persist the offset AFTER a successful
          // handle. On failure, stop the batch so the next poll re-fetches it.
          try { await handle(u.message) }
          catch (e) { console.error(`[err] msg ${u.message.message_id}: ${e.message} — will retry`); break }
        }
        offset = u.update_id + 1
        await fs.writeFile(OFFSET_FILE, String(offset), 'utf8')
      }
    } catch (e) {
      console.error(`[poll] ${e.message}`)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

if (SELFTEST) selftest().catch(e => { console.error(e.message); process.exit(1) })
else main()
