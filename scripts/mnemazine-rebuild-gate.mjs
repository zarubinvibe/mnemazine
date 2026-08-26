#!/usr/bin/env node
// ПРИБОР ОРКЕСТРАЦИИ ВОЛНЫ 0 — маркер пишет код, а не рапорт агента.
//
// Контракт (мастер §8, файл 01 П00):
//   маркер .mnemazine/state/rebuild/<план>.done.json пишет ТОЛЬКО этот прибор и ТОЛЬКО при exit_code 0.
//   маркер без written_by:"rebuild-gate" или с несовпавшим sha_of_changed_files → tampered;
//   --require на tampered/отсутствующий → exit 2. Пустая выборка планов → exit 2, не «сдано 0/0».
//   Исключение внутри проверки плана → crash:<план>, остальные планы продолжают считаться
//   (в отличие от mnemazine-release-check.mjs:921-925, где первый throw убивает остальные).
//   --budget: нет budget.json → exit 2 (потолок не подтверждён); превышение → exit 3.
//   --selftest: репетиция отката (правка→revert→сверка tree-sha) + спрятанный прибор плана → красный.
//
// engines.node >= 20 (package.json): без fs.globSync и без require() из ESM.
import { parseArgs } from 'node:util'
import { promises as fs, existsSync, readFileSync, mkdtempSync, appendFileSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// --- Конфиг прибора (не константы промта: слоты, каталоги, открытые вопросы §6) ---------------------
const CONFIG = {
  stateDir: path.join(REPO, '.mnemazine', 'state', 'rebuild'),
  plansDir: path.join(REPO, 'docs'),
  planFileRe: /^PLAN-ночь-2026-08-22-0[1-6][^/]*\.md$/,
  // Лимит слотов: три исполнителя, по одному на CLI (мастер §9, дополнение 3). Конфиг, не промт.
  slotsPerCli: { claude: 1, codex: 1, kimi: 1 },
  configLocal: path.join(REPO, '.mnemazine', 'config.local.sh'),
  // Открытые вопросы §6 мастер-плана: план не готов, пока его вопрос не отвечён.
  openQuestions: [], // все решены: 3,4 (22.08); 5 — кастомная dual-license, драфт LICENSE.draft.md на утверждении владельца; 10 — публично только чистый релизный коммит, история в приватном (23.08)
  questionBlocks: {},
  claudeDir: path.join(os.homedir(), '.claude', 'projects', `-${REPO.split(path.sep).filter(Boolean).join('-')}`),
  codexSessions: path.join(os.homedir(), '.codex', 'sessions'),
  kimiIndex: path.join(os.homedir(), '.kimi-code', 'session_index.jsonl'),
  // Rate-карта claude за Mtok [in, out, cache-write, cache-read] — как $HOME/.claude/scripts/token-spend.sh.
  claudeRates: { opus: [15, 75, 18.75, 1.5], sonnet: [3, 15, 3.75, 0.3], haiku: [1, 5, 1.25, 0.1] },
  // ponytail: плоская ставка для не-claude CLI; поштучное ценообразование codex/kimi — открытый вопрос 6
  // (владелец задал только ceiling_usd). Ночной расход codex/kimi мал, точность ставки здесь не решает.
  nonClaudeUsdPerMtok: 3,
}

// --- Утилиты -------------------------------------------------------------------------------------
const sha256 = s => createHash('sha256').update(s).digest('hex')
function git(args, opts = {}) {
  return execFileSync('git', ['-C', opts.cwd || REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '')
}
function gitSafe(args, opts) { try { return git(args, opts) } catch { return null } }

/** Нормализует путь из «Точные пути»: снимает `:123`/`:1-9`-хвост строки и завершающий слэш. */
function normPath(raw) {
  let p = raw.trim().replace(/[.,;)]+$/, '')
  p = p.split(/\s/)[0]
  p = p.replace(/:\d+(-\d+)?$/, '')
  p = p.replace(/\/$/, '')
  return p
}

/** Токен из «Точные пути» — реальный путь, а не флаг (`--vault`) или голое слово (`exit`, `complete-check`). */
function isPathLike(raw, norm) {
  if (!norm || norm.startsWith('-')) return false
  return raw.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(norm)
}

/** Читает все P0[1-6]-файлы волн и строит реестр планов машинно из «Точные пути» / «Исполнитель» / «Требует». */
async function loadPlans() {
  const plans = new Map()
  let dir
  try { dir = await fs.readdir(CONFIG.plansDir) } catch { return plans }
  for (const name of dir) {
    if (!CONFIG.planFileRe.test(name)) continue
    const text = await fs.readFile(path.join(CONFIG.plansDir, name), 'utf8')
    for (const p of parsePlansFromText(text, name)) plans.set(p.id, p)
  }
  return plans
}

/** Разбор одного файла волны в блоки планов. Вынесен, чтобы --selftest мог проверить его на фикстуре. */
export function parsePlansFromText(text, file = '') {
  const out = []
  const headRe = /^###\s+(П\d+)\s+·\s+(.*)$/gm
  const heads = []
  let m
  while ((m = headRe.exec(text))) heads.push({ id: m[1], title: m[2].trim(), start: m.index })
  for (let i = 0; i < heads.length; i++) {
    const body = text.slice(heads[i].start, i + 1 < heads.length ? heads[i + 1].start : text.length)
    out.push({ id: heads[i].id, title: heads[i].title, file, ...parsePlanBody(body) })
  }
  return out
}

function parsePlanBody(body) {
  const lines = body.split('\n')
  const executor = (body.match(/\*\*Исполнитель:\*\*\s*([A-Za-z]+)/) || [])[1] || null
  // «Требует маркеров» может занимать несколько строк (`·`-разделитель) и тянуть за собой прозу, которая
  // тоже называет ПNN («`--require` на П21 даёт 2», «(`П01` — не формальность…)»). Собираем поле до
  // следующего `- **`-поля, режем на первой точке-конце-предложения — дальше только пояснения.
  let requires = []
  const reqIdx = lines.findIndex(l => /\*\*Требует маркеров:\*\*/.test(l))
  if (reqIdx >= 0) {
    const buf = [lines[reqIdx].replace(/[\s\S]*\*\*Требует маркеров:\*\*/, '')]
    for (let j = reqIdx + 1; j < lines.length; j++) {
      if (/^\s*-\s*\*\*/.test(lines[j]) || /^###/.test(lines[j])) break
      buf.push(lines[j])
    }
    const head = buf.join(' ').split(/\.(?=\s|$)/)[0]
    requires = [...new Set([...head.matchAll(/П\d+/g)].map(x => x[0]))]
  }
  // «Точные пути»: собираем строки после маркера до следующего поля `- **…**` или конца блока.
  const paths = []
  let inPaths = false
  for (const line of lines) {
    if (/^-\s*\*\*Точные пути:\*\*/.test(line)) { inPaths = true; continue }
    if (inPaths && /^-\s*\*\*/.test(line)) break
    if (!inPaths) continue
    const isNew = /\[новый\]/.test(line)
    for (const bt of line.matchAll(/`([^`]+)`/g)) {
      const p = normPath(bt[1])
      if (isPathLike(bt[1], p)) paths.push({ path: p, isNew })
    }
  }
  return { executor, requires, paths }
}

// --- Маркеры -------------------------------------------------------------------------------------
const markerFile = id => path.join(CONFIG.stateDir, `${id}.done.json`)

/** Пересчёт sha изменённых файлов: sha256(имена \n + содержимое каждого) по фиксированным base..head. */
function changedFilesSha(base, head) {
  const names = (gitSafe(['diff', '--name-only', `${base}..${head}`]) || '').split('\n').filter(Boolean)
  let buf = names.join('\n')
  for (const n of names) buf += '\0' + n + '\0' + (gitSafe(['show', `${head}:${n}`]) ?? '')
  return sha256(buf)
}

/** Классифицирует маркер: {status: done|tampered|missing, data}. tampered ловит и подделку руками. */
function readMarker(id) {
  const f = markerFile(id)
  if (!existsSync(f)) return { status: 'missing' }
  let data
  try { data = JSON.parse(readFileSync(f, 'utf8')) } catch { return { status: 'tampered', reason: 'нечитаемый json', data: null } }
  if (data.written_by !== 'rebuild-gate') return { status: 'tampered', reason: 'нет written_by:"rebuild-gate"', data }
  // Поля целостности обязательны: их отсутствие — подделка обрезанием, не «старый формат».
  for (const k of ['base', 'head', 'sha_of_changed_files', 'exit_code', 'finished_at']) {
    if (data[k] === undefined || data[k] === null || data[k] === '') return { status: 'tampered', reason: `нет поля целостности ${k}`, data }
  }
  if (!gitSafe(['rev-parse', '--verify', data.head + '^{commit}']) || !gitSafe(['rev-parse', '--verify', data.base + '^{commit}'])) {
    return { status: 'tampered', reason: 'base/head не резолвятся в коммиты', data }
  }
  // Пересчёт sha по записанным base/head — детерминирован независимо от текущего HEAD.
  {
    if (changedFilesSha(data.base, data.head) !== data.sha_of_changed_files) return { status: 'tampered', reason: 'sha_of_changed_files не совпал', data }
  }
  return { status: 'done', data }
}

function writeMarker(id, { checkCmd, executor, verifier, base }) {
  mkdirSync(CONFIG.stateDir, { recursive: true })
  const head = git(['rev-parse', 'HEAD'])
  const baseRef = base || `${head}~1`
  const baseSha = gitSafe(['rev-parse', baseRef]) || baseRef
  const marker = {
    plan: id,
    check_cmd: checkCmd || '',
    exit_code: 0,
    sha_of_changed_files: changedFilesSha(baseSha, head),
    base: baseSha,
    head,
    executor_cli: executor || null,
    verifier_cli: verifier || null,
    finished_at: new Date().toISOString(),
    written_by: 'rebuild-gate',
  }
  if (id === 'П00') {
    marker.config_local_sha = existsSync(CONFIG.configLocal) ? sha256(readFileSync(CONFIG.configLocal)) : null
    marker.rollback_rehearsal = rollbackRehearsal()
  }
  if (id === 'П21') {
    const baseline = path.join(CONFIG.stateDir, 'public-history-baseline.json')
    marker.ignored_files_decisions = {
      'scripts/mnemazine-refresh-core-indexes.mjs': 'обезличен и включён',
      'scripts/graphify_clean.py': 'обезличен и включён',
      'scripts/mnemazine-apply-capability-links.mjs': 'включён',
      'scripts/mnemazine-audit-live-vault.mjs': 'включён',
      'scripts/mnemazine-normalize-skill-notes.mjs': 'включён',
      'scripts/kb-enrich-schema.json': 'включён',
      'tests/test-coverage-fix.mjs': 'включён',
      'scripts/mnemazine-build-capability-map.mjs': 'оставлен вырезанным',
      'scripts/mnemazine-dedupe-atomized-blocks.mjs': 'оставлен вырезанным',
      'scripts/kb-build-queue.py': 'оставлен вырезанным',
      'scripts/kb-enrich-codex.sh': 'оставлен вырезанным',
      'scripts/kb-recheck-codex.sh': 'оставлен вырезанным',
      'scripts/kb-enrich-prompt.md': 'оставлен вырезанным',
      'scripts/PROMPT-Codex-desktop.txt': 'оставлен вырезанным',
      'scripts/ИНСТРУКЦИЯ-codex-перепроверка.md': 'оставлен вырезанным',
    }
    marker.public_history_baseline_sha = existsSync(baseline) ? sha256(readFileSync(baseline)) : null
    marker.campaigns_decision = 'docs/campaigns/ оставлен в .gitignore по решению владельца вопроса 4; commit e2b7d92'
  }
  if (id === 'П22') {
    // Доп-поля сверх контракта §8 (мастер §6 файл 06): прежний публичный HEAD, результат
    // песочницы, форма публикации и лицензия. Источник — черновик прибора publish-readiness,
    // который check-cmd написал ДО этого маркера (аналогично public-history-baseline.json у П21).
    const draftFile = path.join(CONFIG.stateDir, 'П22-readiness.json')
    if (!existsSync(draftFile)) throw new Error('П22: нет черновика П22-readiness.json — прибор publish-readiness не отработал до маркера')
    const d = JSON.parse(readFileSync(draftFile, 'utf8'))
    if (d.written_by !== 'publish-readiness') throw new Error('П22: черновик readiness не от прибора publish-readiness')
    if (!/^[0-9a-f]{7,40}$/.test(d.previous_public_sha || '')) throw new Error('П22: в черновике нет прежнего публичного sha')
    marker.previous_public_sha = d.previous_public_sha
    marker.previous_public_sha_full = d.previous_public_sha_full
    marker.sandbox_probe = d.sandbox_probe
    marker.publication_form = d.publication_form
    marker.license_decision = d.license_decision
    marker.deletions_on_push = d.sandbox_probe_full ? d.sandbox_probe_full.deletions : undefined
    marker.pushed = false // маркер означает готовность, а не факт публикации
  }
  writeFileSync(markerFile(id), JSON.stringify(marker, null, 2) + '\n')
  return marker
}

// --- Репетиция отката (инвариант 3 мастер-плана): правка → revert → сверка tree-sha в клоне --------
function rollbackRehearsal() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rebuild-rehearsal-'))
  const dst = path.join(tmp, 'rehearsal')
  try {
    git(['clone', '--local', '--quiet', REPO, dst], { cwd: REPO })
    const before = git(['rev-parse', 'HEAD^{tree}'], { cwd: dst })
    const tracked = git(['ls-files'], { cwd: dst }).split('\n').filter(Boolean)
    if (!tracked.length) throw new Error('клон без отслеживаемых файлов')
    appendFileSync(path.join(dst, tracked[0]), '\n// rebuild-gate rehearsal\n')
    git(['add', '-A'], { cwd: dst })
    git(['-c', 'user.email=rebuild@gate', '-c', 'user.name=rebuild-gate', 'commit', '-q', '-m', 'plan/П00-rehearsal'], { cwd: dst })
    git(['revert', '--no-edit', 'HEAD'], { cwd: dst })
    const after = git(['rev-parse', 'HEAD^{tree}'], { cwd: dst })
    return { before_tree: before, after_tree: after, matched: before === after }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- running.json (для --ready / --start / --finish) ---------------------------------------------
function readRunning() {
  const f = path.join(CONFIG.stateDir, 'running.json')
  if (!existsSync(f)) return { running: [] }
  try { const j = JSON.parse(readFileSync(f, 'utf8')); return { running: Array.isArray(j.running) ? j.running : [] } } catch { return { running: [] } }
}
function writeRunning(state) {
  mkdirSync(CONFIG.stateDir, { recursive: true })
  writeFileSync(path.join(CONFIG.stateDir, 'running.json'), JSON.stringify(state, null, 2) + '\n')
}

// --- Расход (--budget): факт с диска по трём источникам, каждый в try/catch (best-effort) ----------
function claudeRate(model) {
  const l = (model || '').toLowerCase()
  for (const k of Object.keys(CONFIG.claudeRates)) if (l.includes(k)) return CONFIG.claudeRates[k]
  return CONFIG.claudeRates.opus // неизвестная → Opus-rate, консервативно
}
async function claudeSpend(since) {
  let tokens = 0, usd = 0
  let files = []
  try { files = (await fs.readdir(CONFIG.claudeDir)).filter(f => f.endsWith('.jsonl')) } catch { return { tokens, usd } }
  for (const f of files) {
    const full = path.join(CONFIG.claudeDir, f)
    try { if (statSync(full).mtimeMs < since) continue } catch { continue } // префильтр по mtime
    let txt = ''
    try { txt = await fs.readFile(full, 'utf8') } catch { continue }
    for (const ln of txt.split('\n')) {
      if (!ln.trim()) continue
      let o; try { o = JSON.parse(ln) } catch { continue }
      const u = o.message && o.message.usage
      if (!u || o.message.model === '<synthetic>') continue
      if (!(o.timestamp && Date.parse(o.timestamp) >= since)) continue
      const r = claudeRate(o.message.model)
      const a = u.input_tokens || 0, b = u.output_tokens || 0, c = u.cache_creation_input_tokens || 0, d = u.cache_read_input_tokens || 0
      tokens += a + b + c + d
      usd += a / 1e6 * r[0] + b / 1e6 * r[1] + c / 1e6 * r[2] + d / 1e6 * r[3]
    }
  }
  return { tokens, usd }
}
async function codexSpend(since) {
  let tokens = 0
  let entries = []
  try { entries = await fs.readdir(CONFIG.codexSessions, { recursive: true, withFileTypes: true }) } catch { return { tokens, usd: 0 } }
  for (const e of entries) {
    if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue
    const full = path.join(e.parentPath || e.path, e.name)
    try { if (statSync(full).mtimeMs < since) continue } catch { continue }
    let txt = ''
    try { txt = await fs.readFile(full, 'utf8') } catch { continue }
    const lines = txt.split('\n').filter(Boolean)
    let meta; try { meta = JSON.parse(lines[0]) } catch { continue }
    const cwd = meta.payload && meta.payload.cwd
    if (!(cwd && cwd.startsWith(REPO))) continue
    if (!(meta.timestamp && Date.parse(meta.timestamp) >= since)) continue
    let last = null
    for (const ln of lines) { const i = ln.indexOf('"total_token_usage"'); if (i >= 0) { const mm = ln.match(/"total_tokens":(\d+)/); if (mm) last = Number(mm[1]) } }
    if (last != null) tokens += last
  }
  return { tokens, usd: tokens / 1e6 * CONFIG.nonClaudeUsdPerMtok }
}
async function kimiSpend(since) {
  let tokens = 0
  let idx = ''
  try { idx = await fs.readFile(CONFIG.kimiIndex, 'utf8') } catch { return { tokens, usd: 0 } }
  for (const ln of idx.split('\n')) {
    if (!ln.trim()) continue
    let s; try { s = JSON.parse(ln) } catch { continue }
    if (s.workDir !== REPO || !s.sessionDir) continue
    let agents = []
    try { agents = await fs.readdir(path.join(s.sessionDir, 'agents'), { recursive: true, withFileTypes: true }) } catch { continue }
    for (const a of agents) {
      if (!a.isFile() || a.name !== 'wire.jsonl') continue
      const full = path.join(a.parentPath || a.path, a.name)
      let txt = ''
      try { txt = await fs.readFile(full, 'utf8') } catch { continue }
      for (const wl of txt.split('\n')) {
        if (!wl.includes('step.end')) continue
        let o; try { o = JSON.parse(wl) } catch { continue }
        if (!(o.time && o.time >= since)) continue
        const u = (o.event && o.event.usage) || o.usage
        if (!u) continue
        tokens += (u.inputOther || 0) + (u.output || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0)
      }
    }
  }
  return { tokens, usd: tokens / 1e6 * CONFIG.nonClaudeUsdPerMtok }
}
async function computeSpend(since) {
  const [c, x, k] = await Promise.all([
    claudeSpend(since).catch(() => ({ tokens: 0, usd: 0 })),
    codexSpend(since).catch(() => ({ tokens: 0, usd: 0 })),
    kimiSpend(since).catch(() => ({ tokens: 0, usd: 0 })),
  ])
  return {
    tokens: c.tokens + x.tokens + k.tokens,
    usd: c.usd + x.usd + k.usd,
    by_cli: { claude: c, codex: x, kimi: k },
  }
}

// --- Команды -------------------------------------------------------------------------------------
async function cmdBudget(json) {
  const f = path.join(CONFIG.stateDir, 'budget.json')
  let b
  try { b = JSON.parse(readFileSync(f, 'utf8')) } catch {
    console.error('бюджет: budget.json отсутствует или нечитаем — потолок не подтверждён')
    return 2
  }
  const since = b.started_at && !Number.isNaN(Date.parse(b.started_at)) ? Date.parse(b.started_at) : new Date().setHours(0, 0, 0, 0)
  const spend = await computeSpend(since)
  const overTokens = Number.isFinite(b.ceiling_tokens) && b.ceiling_tokens > 0 && spend.tokens > b.ceiling_tokens
  const overUsd = Number.isFinite(b.ceiling_usd) && b.ceiling_usd > 0 && spend.usd > b.ceiling_usd
  const over = overTokens || overUsd
  const report = { ok: !over, ceiling_usd: b.ceiling_usd ?? null, ceiling_tokens: b.ceiling_tokens ?? null, since: new Date(since).toISOString(), spend_tokens: spend.tokens, spend_usd: Number(spend.usd.toFixed(2)), by_cli: spend.by_cli, over_tokens: overTokens, over_usd: overUsd }
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`бюджет с ${report.since}: расход ${spend.tokens.toLocaleString()} ток · ≈$${report.spend_usd}`)
    console.log(`  потолок: $${b.ceiling_usd ?? '—'}${Number.isFinite(b.ceiling_tokens) ? ' / ' + b.ceiling_tokens + ' ток' : ' (токенный не задан)'}`)
    console.log(over ? `  ПРЕВЫШЕНИЕ — волна останавливается` : `  в пределах потолка`)
  }
  return over ? 3 : 0
}

async function cmdStatus(json) {
  const plans = await loadPlans()
  const running = new Set(readRunning().running)
  const rows = []
  for (const id of [...plans.keys()].sort()) {
    const mk = readMarker(id)
    let state = mk.status
    if (state === 'missing') state = running.has(id) ? 'running' : 'pending'
    rows.push({ plan: id, state, executor: plans.get(id).executor, reason: mk.reason || null })
  }
  if (json) console.log(JSON.stringify({ ok: true, plans: rows }, null, 2))
  else {
    console.log('ДОСКА ПЕРЕСТРОЙКИ')
    for (const r of rows) console.log(`  ${r.plan}  ${r.state}${r.reason ? '  (' + r.reason + ')' : ''}`)
  }
  return 0
}

async function cmdReady(json) {
  const plans = await loadPlans()
  if (!plans.size) { console.error('--ready: ноль извлечённых планов'); return 1 }
  const running = readRunning().running
  const runningPaths = new Set()
  const runningCli = new Set()
  for (const id of running) {
    const p = plans.get(id)
    if (!p) continue
    for (const x of p.paths) runningPaths.add(x.path)
    if (p.executor) runningCli.add(p.executor)
  }
  const dependents = id => [...plans.values()].filter(p => p.requires.includes(id)).length
  const ready = [], blocked = {}
  for (const id of [...plans.keys()].sort()) {
    const p = plans.get(id)
    if (readMarker(id).status === 'done' || running.includes(id)) continue
    const reasons = []
    for (const dep of p.requires) if (readMarker(dep).status !== 'done') reasons.push(`ждёт маркер ${dep}`)
    for (const q of (CONFIG.questionBlocks[id] || [])) if (CONFIG.openQuestions.includes(q)) reasons.push(`открыт вопрос ${q}`)
    const inter = p.paths.map(x => x.path).filter(x => runningPaths.has(x))
    if (inter.length) reasons.push(`пересечение путей с бегущим планом: ${[...new Set(inter)].join(', ')}`)
    if (p.executor && runningCli.has(p.executor)) reasons.push(`слот CLI ${p.executor} занят`)
    if (reasons.length) blocked[id] = reasons
    else ready.push(id)
  }
  ready.sort((a, b) => dependents(b) - dependents(a) || a.localeCompare(b))
  const out = { ok: ready.length > 0, ready: ready.map(id => ({ plan: id, executor: plans.get(id).executor })), blocked }
  if (json) console.log(JSON.stringify(out, null, 2))
  else {
    if (ready.length) { console.log('ГОТОВЫ К ЗАПУСКУ:'); for (const id of ready) console.log(`  ${id} (${plans.get(id).executor})`) }
    else { console.log('готовых нет; блокеры:'); for (const id of Object.keys(blocked).sort()) console.log(`  ${id}: ${blocked[id].join('; ')}`) }
  }
  return ready.length ? 0 : 1
}

async function cmdPlan(id, requireCsv, opts) {
  const plans = await loadPlans()
  if (!plans.has(id)) { console.error(`пустая выборка планов: план ${id} не в реестре П00–П24`); return 2 }
  const deps = (requireCsv || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const dep of deps) {
    const mk = readMarker(dep)
    if (mk.status !== 'done') { console.error(`план ${id} блокирован отсутствующим ${dep}${mk.status === 'tampered' ? ' (tampered: ' + mk.reason + ')' : ''}`); return 2 }
  }
  if (opts.checkCmd) {
    const res = spawnSync('/bin/sh', ['-c', opts.checkCmd], { stdio: 'inherit' })
    const code = res.status == null ? 1 : res.status
    if (code !== 0) { console.error(`проверка ${id} дала код ${code} — маркер не пишется`); return code }
    writeMarker(id, opts)
    console.log(`маркер ${id} записан (exit_code 0)`)
    return 0
  }
  console.log(`${id} разблокирован: маркеры require закрыты (${deps.length ? deps.join(',') : 'нет зависимостей'})`)
  return 0
}

function cmdStartFinish(id, action) {
  const st = readRunning()
  if (action === 'start' && !st.running.includes(id)) st.running.push(id)
  if (action === 'finish') st.running = st.running.filter(x => x !== id)
  writeRunning(st)
  console.log(`${action}: бегут ${st.running.length ? st.running.join(', ') : '(никто)'}`)
  return 0
}

function cmdContracts(json) {
  const c = {
    marker_fields: ['plan', 'check_cmd', 'exit_code', 'sha_of_changed_files', 'base', 'head', 'executor_cli', 'verifier_cli', 'finished_at', 'written_by', '(П00: config_local_sha, rollback_rehearsal)'],
    rules: [
      'маркер пишет только rebuild-gate и только при exit_code 0',
      'маркер без written_by:"rebuild-gate" или с несовпавшим sha → tampered; --require на него → exit 2',
      'пустая выборка планов → exit 2, не «сдано 0/0»',
      'исключение внутри проверки плана → crash:<план>, остальные считаются',
      'нет budget.json → exit 2; превышение → exit 3',
      '--selftest: репетиция отката + спрятанный прибор плана красит проверку',
    ],
    budget: { file: path.relative(REPO, path.join(CONFIG.stateDir, 'budget.json')), ceiling: 'ceiling_usd (владелец §5.11), ceiling_tokens опционально' },
    ready: { slots: CONFIG.slotsPerCli, open_questions: CONFIG.openQuestions, question_blocks: CONFIG.questionBlocks },
  }
  if (json) console.log(JSON.stringify(c, null, 2))
  else {
    console.log('КОНТРАКТ rebuild-gate')
    console.log('  поля маркера: ' + c.marker_fields.join(', '))
    for (const r of c.rules) console.log('  · ' + r)
    console.log('  бюджет: ' + c.budget.file + ' — ' + c.budget.ceiling)
    console.log('  слоты: ' + JSON.stringify(c.ready.slots) + ' · открытые вопросы §6: ' + c.ready.open_questions.join(','))
  }
  return 0
}

// --- selftest: детерминированные утверждения + репетиция отката + спрятанный прибор ---------------
async function cmdSelftest() {
  const { strictEqual: eq, ok } = await import('node:assert')

  // 1. Разбор блока плана из фикстуры (изолирован от диска).
  const fixture = [
    '### П77 · Фикстура',
    '- **Точные пути:**',
    '  - `scripts/some-tool.mjs:12-20` — **[новый]**',
    '  - `scripts/mnemazine-coverage-check.mjs:53-68` — образец',
    '- **Исполнитель:** codex. **Проверяющий:** claude.',
    '- **Требует маркеров:** П00, П01.',
    '',
    '### П78 · Вторая',
    '- **Точные пути:**',
    '  - `scripts/mnemazine-coverage-check.mjs` — общий файл',
    '- **Исполнитель:** kimi. **Проверяющий:** codex.',
    '- **Требует маркеров:** —',
  ].join('\n')
  const parsed = parsePlansFromText(fixture, 'fixture.md')
  eq(parsed.length, 2)
  eq(parsed[0].id, 'П77')
  eq(parsed[0].executor, 'codex')
  eq(JSON.stringify(parsed[0].requires), JSON.stringify(['П00', 'П01']))
  eq(parsed[1].requires.length, 0) // «—» = нет зависимостей
  // normPath снял `:12-20` и `:53-68`
  eq(parsed[0].paths[0].path, 'scripts/some-tool.mjs')
  eq(parsed[0].paths[0].isNew, true)
  eq(parsed[0].paths[1].path, 'scripts/mnemazine-coverage-check.mjs')
  eq(parsed[0].paths[1].isNew, false)
  // пересечение путей П77 ↔ П78 по общему файлу
  const inter = parsed[0].paths.map(x => x.path).filter(x => parsed[1].paths.map(y => y.path).includes(x))
  eq(inter[0], 'scripts/mnemazine-coverage-check.mjs')

  // 2. Классификатор tampered на объекте без written_by (без обращения к git).
  eq(normPath('`x.mjs:10`'.replace(/`/g, '')), 'x.mjs')
  eq(normPath('.mnemazine/state/rebuild/'), '.mnemazine/state/rebuild')

  // 3. Реальные планы извлекаются; ноль → красный (мастер §8).
  const plans = await loadPlans()
  ok(plans.size >= 1, 'ноль извлечённых планов — selftest красный')

  // 4. Спрятанный прибор плана: git-отслеживаемые не-[новый] repo-пути обязаны существовать на диске.
  //    mv scripts/mnemazine-coverage-check.mjs /tmp/ уводит отслеживаемый файл → эта проверка краснеет.
  const tracked = new Set((gitSafe(['ls-files']) || '').split('\n').filter(Boolean))
  const missing = []
  for (const p of plans.values()) {
    for (const x of p.paths) {
      if (x.isNew) continue
      const rel = x.path
      if (rel.startsWith('/') || rel.startsWith('~') || rel.includes('://')) continue
      if (!tracked.has(rel)) continue // не отслеживается — не наша ответственность
      if (!existsSync(path.join(REPO, rel))) missing.push(`${p.id}:${rel}`)
    }
  }
  ok(missing.length === 0, 'спрятан отслеживаемый прибор плана: ' + missing.join(', '))

  // 5. Репетиция отката — обязательная часть П00, не декларация.
  const reh = rollbackRehearsal()
  eq(reh.matched, true, `откат не восстановил дерево: ${reh.before_tree} != ${reh.after_tree}`)

  console.log('selftest ok')
  console.log(`  rollback_rehearsal.before_tree = ${reh.before_tree}`)
  console.log(`  rollback_rehearsal.after_tree  = ${reh.after_tree}`)
  console.log(`  извлечено планов: ${plans.size}`)
  return 0
}

// --- Диспетчер -----------------------------------------------------------------------------------
async function main() {
  let v
  try {
    ({ values: v } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        plan: { type: 'string' }, require: { type: 'string' },
        status: { type: 'boolean' }, contracts: { type: 'boolean' }, budget: { type: 'boolean' },
        ready: { type: 'boolean' }, selftest: { type: 'boolean' }, json: { type: 'boolean' },
        start: { type: 'string' }, finish: { type: 'string' },
        'check-cmd': { type: 'string' }, executor: { type: 'string' }, verifier: { type: 'string' }, base: { type: 'string' },
        'state-dir': { type: 'string' },
      },
    }))
  } catch (e) { console.error('разбор аргументов: ' + e.message); return 2 }

  // --state-dir изолирует боевые маркеры от проб (probe #1/#3/#4 гоняются в одноразовом каталоге).
  if (v['state-dir']) CONFIG.stateDir = path.resolve(v['state-dir'])

  if (v.selftest) return cmdSelftest()
  if (v.contracts) return cmdContracts(v.json)
  if (v.status) return cmdStatus(v.json)
  if (v.ready) return cmdReady(v.json)
  if (v.budget) return cmdBudget(v.json)
  if (v.start) return cmdStartFinish(v.start, 'start')
  if (v.finish) return cmdStartFinish(v.finish, 'finish')
  if (v.plan !== undefined) return cmdPlan(v.plan, v.require, { checkCmd: v['check-cmd'], executor: v.executor, verifier: v.verifier, base: v.base })

  console.log('rebuild-gate — прибор оркестрации волны 0. Флаги: --plan --require --status --contracts --budget --ready --selftest --json --start --finish')
  return 0
}

main().then(code => process.exit(code)).catch(err => { console.error(err && err.message || err); process.exit(1) })
