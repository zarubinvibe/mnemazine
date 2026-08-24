#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const JSON_OUT = argv.includes('--json')
const REQUIRE_OK = argv.includes('--require-ok')
const ROOT = path.resolve(arg('root', process.env.MNEMAZINE_ROOT || process.cwd()))

function expandHome(value) {
  const home = process.env.HOME || ''
  return String(value || '').replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home)
}

function unquote(value) {
  const trimmed = String(value || '').trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

async function localConfig() {
  const file = path.join(ROOT, '.mnemazine/config.local.sh')
  const body = await fs.readFile(file, 'utf8').catch(() => '')
  const out = {}
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?(MNEMAZINE_(?:INBOX|VAULT|REPORTS|STATE))=(.+?)\s*$/)
    if (match) out[match[1]] = expandHome(unquote(match[2]))
  }
  return out
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function activeCount(dir) {
  let count = 0
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (item.isFile() && !item.name.startsWith('.')) count += 1
  }
  return count
}

async function newestFile(dir, ext) {
  const files = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!item.isFile() || !item.name.endsWith(ext)) continue
    const file = path.join(dir, item.name)
    files.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs })
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || ''
}

function rel(file, root = ROOT) {
  return file ? path.relative(root, file) || '.' : null
}

async function status(root = ROOT) {
  const cfg = root === ROOT ? await localConfig() : {}
  const stateDir = path.resolve(process.env.MNEMAZINE_STATE || cfg.MNEMAZINE_STATE || path.join(root, '.mnemazine/state'))
  const reportsDir = path.resolve(process.env.MNEMAZINE_REPORTS || cfg.MNEMAZINE_REPORTS || path.join(root, 'reports'))
  const inboxDir = path.resolve(process.env.MNEMAZINE_INBOX || cfg.MNEMAZINE_INBOX || path.join(root, 'inbox'))
  const nestedInbox = path.join(inboxDir, 'mnemazine-inbox')
  const lastRunFile = path.join(stateDir, 'last-run.json')
  const briefFile = path.join(stateDir, 'last-action-brief.md')
  const lastRun = await readJson(lastRunFile)
  const latestHtml = await newestFile(reportsDir, '.html')
  const latestMd = await newestFile(reportsDir, '.md')
  const inbox = await activeCount(inboxDir)
  const nested = existsSync(nestedInbox) ? await activeCount(nestedInbox) : 0
  const failures = []
  if (!lastRun) failures.push('last-run.json missing')
  if (lastRun && !lastRun.ok) failures.push(lastRun.failure || (lastRun.failures || []).join('; ') || 'last run failed')
  // Смерть литерала ok:true наблюдаема и здесь: даже если поле ok врёт зелёным,
  // failed>0 означает, что прогон не чист. --require-ok обязан покраснеть.
  if (lastRun && Number(lastRun.failed || 0) > 0) failures.push(`last run had ${lastRun.failed} failed file(s)`)
  if (lastRun?.deep_required && !lastRun.deep) failures.push('strict run was not deep')
  if (lastRun?.deep_required && lastRun?.synthesize?.degraded) failures.push('deep synthesis degraded')
  if (lastRun?.deep_required && lastRun?.strict_archive_knowledge !== true) failures.push('strict archive gate missing')
  if (!existsSync(briefFile)) failures.push('last-action-brief.md missing')
  if (!latestHtml) failures.push('HTML report missing')
  return {
    ok: failures.length === 0,
    failures,
    inbox,
    nested_inbox: nested,
    last_run: lastRun ? {
      ok: Boolean(lastRun.ok),
      processed: Number(lastRun.processed || 0),
      cached_only: Number(lastRun.cached_only || 0),
      failed: Number(lastRun.failed || 0),
      archived: Number(lastRun.archived || 0),
      deep: Boolean(lastRun.deep),
      deep_required: Boolean(lastRun.deep_required),
      strict_archive_knowledge: Boolean(lastRun.strict_archive_knowledge),
      atomized: Number(lastRun.synthesize?.atomized || 0),
      enriched: Number(lastRun.synthesize?.enriched || 0),
      started_at: lastRun.started_at || null,
      finished_at: lastRun.finished_at || null
    } : null,
    paths: {
      inbox: inboxDir,
      state: rel(stateDir, root),
      last_run: rel(lastRunFile, root),
      brief: existsSync(briefFile) ? rel(briefFile, root) : null,
      latest_html: rel(latestHtml, root),
      latest_md: rel(latestMd, root)
    }
  }
}

async function selftest() {
  const temp = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'mnemazine-live-status-'))
  await fs.mkdir(path.join(temp, '.mnemazine/state'), { recursive: true })
  await fs.mkdir(path.join(temp, 'reports'), { recursive: true })
  await fs.mkdir(path.join(temp, 'inbox'), { recursive: true })
  await fs.writeFile(path.join(temp, '.mnemazine/state/last-action-brief.md'), '# Brief\n', 'utf8')
  await fs.writeFile(path.join(temp, 'reports/live.html'), '<!doctype html><html></html>', 'utf8')
  await fs.writeFile(path.join(temp, 'reports/live.md'), '# Report\n', 'utf8')
  await fs.writeFile(path.join(temp, '.mnemazine/state/last-run.json'), JSON.stringify({
    ok: true,
    processed: 2,
    cached_only: 1,
    failed: 0,
    archived: 3,
    deep: true,
    deep_required: true,
    strict_archive_knowledge: true,
    synthesize: { atomized: 2, enriched: 2 },
    started_at: '2099-01-01T00:00:00.000Z',
    finished_at: '2099-01-01T00:01:00.000Z'
  }, null, 2), 'utf8')
  const s = await status(temp)
  await fs.rm(temp, { recursive: true, force: true })
  if (!s.ok || s.last_run.processed !== 2 || s.last_run.archived !== 3) throw new Error('live status selftest failed')
  console.log('live-status selftest ok')
}

function printText(s) {
  const run = s.last_run
  console.log(`Status: ${s.ok ? 'ok' : 'failed'}`)
  if (s.failures.length) console.log(`Failures: ${s.failures.join('; ')}`)
  console.log(`Inbox: ${s.inbox}${s.nested_inbox ? ` (+${s.nested_inbox} nested)` : ''}`)
  if (run) {
    console.log(`Run: processed=${run.processed} cached=${run.cached_only} failed=${run.failed} archived=${run.archived}`)
    console.log(`Deep: ${run.deep ? 'yes' : 'no'} required=${run.deep_required ? 'yes' : 'no'} strict_archive=${run.strict_archive_knowledge ? 'yes' : 'no'}`)
    console.log(`Atoms: atomized=${run.atomized} enriched=${run.enriched}`)
    if (run.finished_at) console.log(`Finished: ${run.finished_at}`)
  }
  if (s.paths.latest_html) console.log(`Report: ${s.paths.latest_html}`)
  if (s.paths.brief) console.log(`Brief: ${s.paths.brief}`)
  if (s.paths.last_run) console.log(`State: ${s.paths.last_run}`)
}

if (argv.includes('--selftest')) {
  selftest().catch(error => { console.error(error.message || error); process.exit(1) })
} else {
  status().then(s => {
    if (JSON_OUT) console.log(JSON.stringify(s, null, 2))
    else printText(s)
    if (REQUIRE_OK && !s.ok) process.exit(1)
  }).catch(error => { console.error(error.message || error); process.exit(1) })
}
