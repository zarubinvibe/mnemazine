#!/usr/bin/env node
// ponytail: one local queue/worker; all clients must use the same root.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const script = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(script), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function syncDir(directory) {
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
  syncDir(path.dirname(file))
}
function identity(pid) {
  return spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout?.trim() || ''
}
function sameProcess(owner) { return owner?.pid > 0 && alive(owner.pid) && identity(owner.pid) === owner.started }
function ownedGroup(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1 || !owner.started) return false
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,lstart='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Cannot inspect process groups safely')
  const members = result.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(match => match && Number(match[2]) === owner.pid)
    .map(match => ({ pid: Number(match[1]), started: match[3].trim() }))
  if (!members.length) return false
  const leader = members.find(member => member.pid === owner.pid)
  if (leader) return leader.started === owner.started
  // A dead leader cannot prove group ownership across PID reuse after a crash.
  throw new Error(`Ambiguous live process group ${owner.pid}: leader exited; queue paused until the group exits`)
}
async function lock(file, wait = true) {
  for (let i = 0; i < (wait ? 600 : 1); i++) {
    try {
      fs.mkdirSync(file, { mode: 0o700 })
      atomic(path.join(file, 'owner.json'), { pid: process.pid, started: identity(process.pid) })
      return () => fs.rmSync(file, { recursive: true, force: true })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let owner
      try { owner = JSON.parse(fs.readFileSync(path.join(file, 'owner.json'), 'utf8')) } catch {}
      // Never reclaim an owner that may still be publishing its lock record.
      let stale = false
      try { stale = owner ? !sameProcess(owner) : Date.now() - fs.statSync(file).mtimeMs > 30000 } catch (err) { if (err.code !== 'ENOENT') throw err; i--; continue }
      if (stale) {
        const reaper = path.join(file, '.reaper')
        try {
          fs.mkdirSync(reaper)
          atomic(path.join(reaper, 'owner.json'), { pid: process.pid, started: identity(process.pid) })
          let current
          try { current = JSON.parse(fs.readFileSync(path.join(file, 'owner.json'), 'utf8')) } catch {}
          if (current && sameProcess(current)) fs.rmSync(reaper, { recursive: true })
          else fs.renameSync(file, `${file}.stale-${randomUUID()}`)
        } catch (err) {
          if (!['ENOENT', 'EEXIST'].includes(err.code)) throw err
          if (err.code === 'EEXIST') {
            let reaperOwner
            try { reaperOwner = JSON.parse(fs.readFileSync(path.join(reaper, 'owner.json'), 'utf8')) } catch {}
            try {
              if (reaperOwner ? !sameProcess(reaperOwner) : Date.now() - fs.statSync(reaper).mtimeMs > 30000) fs.renameSync(reaper, `${reaper}.stale-${randomUUID()}`)
            } catch (failure) { if (failure.code !== 'ENOENT') throw failure }
            await sleep(50)
          }
        }
        i--; continue
      }
      if (!wait) return null
      await sleep(50)
    }
  }
  throw new Error('Queue is busy; retry later')
}
function validateId(id) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('Invalid job id')
  return id
}
export class JobQueue {
  constructor(root = path.join(repo, '.mnemazine/state/jobs')) {
    this.root = path.resolve(root)
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  dir(id) { return path.join(this.root, validateId(id)) }
  read(id) { return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'job.json'), 'utf8')) }
  list() {
    return fs.readdirSync(this.root).filter(x => /^[0-9a-f-]{36}$/.test(x) && fs.existsSync(path.join(this.root, x, 'job.json')))
      .map(id => this.read(id)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  }
  save(job, event) {
    job.updated_at = now()
    // State and event history commit together: no torn JSONL/state dual write.
    job.events = [...(job.events || []), { at: job.updated_at, event, status: job.status }]
    atomic(path.join(this.dir(job.id), 'job.json'), job)
    return job
  }
  async transaction(fn) {
    const release = await lock(path.join(this.root, '.state-lock'))
    try { return fn() } finally { release() }
  }
  async submit({ kind, query, files = [], text, mode, project, provenance }) {
    if (!['ingest', 'search', 'brief'].includes(kind)) throw new Error('kind must be ingest, search or brief')
    mode ||= 'local'
    if (!['local', 'deep'].includes(mode)) throw new Error('mode must be local or deep')
    if (kind === 'ingest' && mode === 'local') throw new Error('Strict ingest requires deep mode; local ingest is not supported')
    const hasText = text !== undefined
    if (kind === 'ingest' ? (hasText === Boolean(files.length) || query !== undefined) : (!query?.trim() || files.length || hasText)) throw new Error('ingest requires either files or text; search/brief require a query and no intake inputs')
    let input_text, input_kind, source_url
    if (hasText) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Text must contain 1–8192 UTF-8 bytes without control characters')
      input_text = text.trim()
      input_kind = 'title'
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input_text)) {
        let url
        try { url = new URL(input_text) } catch { throw new Error('Invalid URL') }
        if (!/^https?:\/\//i.test(input_text) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(input_text)) throw new Error('Only http/https URLs without credentials are supported')
        input_kind = 'url'
        source_url = url.href
      } else if (/^(?:\/\/|www\.)/i.test(input_text)) throw new Error('Use a complete http/https URL')
    }
    if (query && (query.length > 16000 || query.includes('\0'))) throw new Error('Invalid query')
    if (project && !/^[\p{L}\p{N}_.-]{1,128}$/u.test(project)) throw new Error('Invalid project id')
    if (provenance && (typeof provenance !== 'object' || Array.isArray(provenance) || JSON.stringify(provenance).length > 8192)) throw new Error('Invalid provenance')
    // Snapshot before publication: worker never sees partially copied inputs.
    const id = randomUUID(), dir = this.dir(id)
    fs.mkdirSync(path.join(dir, 'sources'), { recursive: true, mode: 0o700 })
    syncDir(this.root)
    const copied = []
    if (hasText) {
      // Existing enrichment treats text as research seed; this is no factual note.
      const request = `# Запрос на исследование\n\nТип входа: ${input_kind === 'url' ? 'ссылка' : 'название или тема'}.\n\nИсходный ввод пользователя:\n${input_text.split('\n').map(line => `> ${line}`).join('\n')}\n${source_url ? `\nИсточник: ${source_url}\n` : ''}\nЭто запрос на исследование, а не готовое знание и не подтверждение фактов. Сначала установите первичный источник и точный предмет запроса. Изучите доступный материал, проверьте утверждения по источникам и сохраните только подтверждённые выводы со ссылками. Если источник недоступен или название неоднозначно, явно сообщите ограничение; не выдумывайте содержание, автора, расшифровку видео или результаты.\n`
      const hash = createHash('sha256').update(request).digest('hex')
      const name = `${hash.slice(0, 16)}-research-request.md`
      const snapshot = path.join(dir, 'sources', name)
      const fd = fs.openSync(snapshot, 'wx', 0o600)
      try { fs.writeFileSync(fd, request); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      copied.push({ snapshot, name, sha256: hash })
    }
    for (const source of files) {
      const original = path.resolve(source)
      const fd = fs.openSync(original, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      let data
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) throw new Error('Input must be a regular file')
        if (stat.size > 512 * 1024 * 1024) throw new Error('File exceeds the current 512 MiB intake limit')
        data = fs.readFileSync(fd)
      } finally { fs.closeSync(fd) }
      const hash = createHash('sha256').update(data).digest('hex')
      if (copied.some(f => f.sha256 === hash)) continue
      const name = `${hash.slice(0, 16)}-${path.basename(original).replace(/^\.+/, '') || 'file'}`
      const snapshot = path.join(dir, 'sources', name)
      const out = fs.openSync(snapshot, 'wx', 0o600)
      try { fs.writeFileSync(out, data); fs.fsyncSync(out) } finally { fs.closeSync(out) }
      copied.push({ original, snapshot, name, sha256: hash })
    }
    syncDir(path.join(dir, 'sources'))
    return this.transaction(() => {
      const fingerprint = kind === 'ingest' ? createHash('sha256').update(JSON.stringify({ ...(hasText ? { input_text } : { hashes: copied.map(f => f.sha256).sort() }), project, provenance })).digest('hex') : null
      const previous = fingerprint && this.list().find(j => j.fingerprint === fingerprint && ['queued', 'running', 'completed'].includes(j.status))
      if (previous) { fs.rmSync(dir, { recursive: true }); return { ...previous, deduplicated: true } }
      return this.save({ id, kind, query, mode, project, provenance, input_text, input_kind, files: copied, fingerprint, status: 'queued', created_at: now(), attempts: 0 }, 'submitted')
    })
  }
  async change(id, action) {
    return this.transaction(() => {
      const job = this.read(id)
      if (action === 'cancel' && ['queued', 'running'].includes(job.status)) {
        job.cancel_requested = true
        if (job.status === 'queued') job.status = 'cancelled'
        return this.save(job, 'cancel_requested')
      }
      if (action === 'retry') {
        if (!['failed', 'cancelled'].includes(job.status)) throw new Error('Only failed/cancelled jobs can be retried')
        for (const blocked of this.list().filter(j => j.recovery_blocked || j.id === id)) recordedGroups(this.dir(blocked.id)).concat(blocked.child || []).forEach(ownedGroup)
        job.status = 'queued'; delete job.error; delete job.result; delete job.cancel_requested
        delete job.recovery_blocked
        return this.save(job, 'retried')
      }
      return job
    })
  }
  async work({ once = false, execute = executeJob } = {}) {
    const release = await lock(path.join(this.root, '.worker-lock'), false)
    if (!release) return { worker: 'already_running' }
    let stopping = false, activeChild
    const stop = () => { stopping = true; if (activeChild) terminate(activeChild) }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    try {
      // A killed worker may leave its separate child process group alive.
      for (const job of this.list().filter(j => j.status === 'running' || j.recovery_blocked)) {
        let groups
        try {
          groups = recordedGroups(this.dir(job.id)).concat(job.child || []).filter(ownedGroup)
          for (const group of groups) terminate(group)
          if (groups.length) await sleep(1000)
          for (const group of groups) if (ownedGroup(group)) terminate(group, 'SIGKILL')
        }
        catch (error) {
          await this.transaction(() => { const fresh = this.read(job.id); fresh.status = 'failed'; fresh.error = error.message; fresh.recovery_blocked = true; this.save(fresh, 'recovery_blocked') })
          throw error
        }
        await this.transaction(() => {
          const fresh = this.read(job.id)
          fresh.status = job.recovery_blocked ? 'failed' : (fresh.cancel_requested ? 'cancelled' : 'queued')
          delete fresh.recovery_blocked
          delete fresh.child
          this.save(fresh, 'worker_recovered')
        })
      }
      do {
        const job = await this.transaction(() => {
          const next = this.list().find(j => j.status === 'queued')
          if (!next) return null
          next.status = 'running'; next.attempts++
          return this.save(next, 'started')
        })
        if (!job) { if (once) break; await sleep(750); continue }
        let result, error
        try {
          result = await execute(job, this.dir(job.id), async child => {
            activeChild = child
            await this.transaction(() => { const j = this.read(job.id); j.child = child; this.save(j, 'child_started') })
          }, () => stopping || this.read(job.id).cancel_requested)
        } catch (e) { error = e.message }
        activeChild = null
        await this.transaction(() => {
          const fresh = this.read(job.id)
          if (error?.includes('Ambiguous live process group')) fresh.recovery_blocked = true
          fresh.status = fresh.recovery_blocked ? 'failed' : (fresh.cancel_requested ? 'cancelled' : (error ? 'failed' : 'completed'))
          if (error) fresh.error = error
          if (result) fresh.result = result
          if (!fresh.recovery_blocked) delete fresh.child
          this.save(fresh, fresh.status)
        })
        if (this.read(job.id).recovery_blocked) throw new Error(this.read(job.id).error)
      } while (!once && !stopping)
      return { worker: 'stopped' }
    } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); release() }
  }
}
function terminate(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') throw e }
}
function recordedGroups(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'process-groups.jsonl'), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line))
  } catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
export function pipelineFailure(dir, outcome) {
  const details = []
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state/last-run.json'), 'utf8'))
    details.push(...(Array.isArray(state.failures) ? state.failures : [state.failure]).filter(value => typeof value === 'string').map(value => value.slice(0, 500)))
    const extracts = path.join(dir, 'cache/extracted')
    for (const file of fs.readdirSync(extracts).filter(name => name.endsWith('.json')).slice(0, 20)) {
      const record = JSON.parse(fs.readFileSync(path.join(extracts, file), 'utf8'))
      if (record.status !== 'needs_manual_context' || typeof record.text_path !== 'string' || path.basename(record.text_path) !== record.text_path) continue
      const fd = fs.openSync(path.join(extracts, record.text_path), 'r')
      let text
      try { const buffer = Buffer.alloc(16384); text = buffer.subarray(0, fs.readSync(fd, buffer)).toString('utf8') }
      finally { fs.closeSync(fd) }
      const length = text.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 2000).length
      details.unshift(length > 0 && length < 80
        ? `Файл прочитан, но текст слишком короткий: ${length} символов; нужно не менее 80. Добавьте содержательный контекст.`
        : 'Недостаточно читаемого текста для обработки. Добавьте текстовый контекст или проверьте качество исходного файла.')
    }
  } catch { /* The pipeline can fail before state or extracts exist. Keep exit diagnostics. */ }
  return `${[...new Set(details)].join(' ')}${details.length ? ' ' : ''}Pipeline exited ${outcome.code ?? outcome.signal}; see ${path.join(dir, 'error.log')}`
}
async function executeJob(job, dir, recordChild, cancelled) {
  const env = { ...process.env, MNEMAZINE_ROOT: repo, MNEMAZINE_DEEP: job.mode === 'deep' ? '1' : '0', MNEMAZINE_SEARCH_VERIFY: job.mode === 'deep' ? '1' : '0', MNEMAZINE_SEARCH_LOG: path.join(dir, 'queries.jsonl'), MNEMAZINE_JOB_GROUPS: path.join(dir, 'process-groups.jsonl') }
  let command = process.execPath, args
  if (job.kind === 'ingest') {
    for (const sub of ['inbox', 'state', 'reports', 'archive', 'cache/extracted']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    for (const file of job.files) {
      if (createHash('sha256').update(fs.readFileSync(file.snapshot)).digest('hex') !== file.sha256) throw new Error('Source snapshot integrity check failed')
      fs.copyFileSync(file.snapshot, path.join(dir, 'inbox', file.name))
    }
    Object.assign(env, {
      MNEMAZINE_INBOX: path.join(dir, 'inbox'), MNEMAZINE_STATE: path.join(dir, 'state'),
      MNEMAZINE_REPORTS: path.join(dir, 'reports'), MNEMAZINE_ARCHIVE: path.join(dir, 'archive'),
      MNEMAZINE_CACHE: path.join(dir, 'cache/hashes.json'), MNEMAZINE_EXTRACTS: path.join(dir, 'cache/extracted'),
      MNEMAZINE_REQUIRE_DEEP: '1', MNEMAZINE_RUN_ID: job.id,
    })
    command = 'bash'; args = [path.join(repo, 'scripts/mnemazine-desktop-protocol.sh')]
  } else {
    args = [path.join(repo, 'scripts/mnemazine-kb-search.mjs'), `--topic=${job.query}`, '--result-json']
    if (job.mode === 'deep') args.push('--deep', '--verify')
  }
  const outputPath = path.join(dir, 'output.log'), errorPath = path.join(dir, 'error.log')
  const output = fs.openSync(outputPath, 'w', 0o600), errors = fs.openSync(errorPath, 'w', 0o600)
  let child
  try { child = spawn(command, args, { cwd: repo, env, detached: true, stdio: ['ignore', output, errors] }) }
  finally { fs.closeSync(output); fs.closeSync(errors) }
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  if (child.pid) await recordChild({ pid: child.pid, started: identity(child.pid) })
  let killedAt = 0
  let monitorError
  const killedGroups = new Map()
  const cancelGroups = () => {
    for (const group of recordedGroups(dir).filter(ownedGroup)) {
      if (!killedGroups.has(group.pid)) { killedGroups.set(group.pid, group); terminate(group) }
    }
    if (!killedAt) { killedAt = Date.now(); terminate(child) }
    else if (Date.now() - killedAt > 2000) terminate(child, 'SIGKILL')
  }
  const timer = setInterval(() => {
    try { if (child.pid && cancelled()) cancelGroups() }
    catch (e) { monitorError = e; killedAt ||= Date.now(); if (child.pid) terminate(child) }
  }, 100)
  let outcome
  try {
    outcome = await completion
    if (child.pid && cancelled() && !monitorError) cancelGroups()
    if (killedAt) {
      await sleep(Math.max(0, 2000 - (Date.now() - killedAt)))
      terminate(child, 'SIGKILL')
      for (const group of killedGroups.values()) if (ownedGroup(group)) terminate(group, 'SIGKILL')
    }
  } finally { clearInterval(timer) }
  if (monitorError) throw monitorError
  if (outcome.code !== 0) throw new Error(pipelineFailure(dir, outcome))
  const result = job.kind === 'ingest' ? { text: 'Обработка копий завершена. Оригиналы сохранены.' } : JSON.parse(fs.readFileSync(outputPath, 'utf8'))
  if (typeof result.text !== 'string') throw new Error('Search returned no report text')
  const { text } = result
  const report_path = path.join(dir, 'result.md')
  fs.writeFileSync(report_path, text, { mode: 0o600 })
  return { ...result, report_path }
}
function startWorker(root) {
  const child = spawn(process.execPath, [script, 'work', '--root', root], { cwd: repo, detached: true, stdio: 'ignore' })
  child.unref()
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, kind: { type: 'string' }, id: { type: 'string' }, file: { type: 'string', multiple: true },
    query: { type: 'string' }, text: { type: 'string' }, mode: { type: 'string' }, project: { type: 'string' }, provenance: { type: 'string' },
    'no-start': { type: 'boolean' }, once: { type: 'boolean' },
  } })
  const [action] = positionals
  if (positionals.length !== 1 || !['submit', 'list', 'status', 'cancel', 'retry', 'work'].includes(action)) throw new Error('Usage: mnemazine-jobs.mjs submit|list|status|cancel|retry|work [options]')
  const queue = new JobQueue(values.root)
  let result
  if (action === 'submit') result = { job: await queue.submit({ ...values, files: values.file, provenance: values.provenance ? JSON.parse(values.provenance) : undefined }) }
  if (action === 'list') result = { jobs: queue.list() }
  if (action === 'status') result = { job: queue.read(values.id) }
  if (['cancel', 'retry'].includes(action)) result = { job: await queue.change(values.id, action) }
  if (action === 'work') result = await queue.work({ once: values.once })
  if (!values['no-start'] && (['submit', 'retry'].includes(action) || (['list', 'status'].includes(action) && queue.list().some(j => ['queued', 'running'].includes(j.status))))) startWorker(queue.root)
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) main().catch(e => { console.error(e.message); process.exitCode = 1 })
