#!/usr/bin/env node
// mnemazine-vault-hygiene-check.mjs — прибор П15 «Гигиена vault».
//
// Три режима:
//   --snapshot --out <file>   слепок vault: basename всех .md, sha256 каждого,
//                             вес по каталогам, wikilink-вхождения внутри/вне
//                             graphify-каталогов, число путей в git status.
//   --compare [before]        множество basename before-слепка == ЖИВОМУ диску:
//                             свежий срез vault снимается самим --compare в момент
//                             запуска, отдельный after-слепок не нужен (можно вывести
//                             побочно через --after-out <file>). Без позиционного
//                             аргумента before берется из .mnemazine/state/vault-
//                             hygiene-before.json. Нет before-слепка → exit 2
//                             (fail-closed: сверка без базиса — это не «зеленый»).
//                             Расхождение → exit 1 с именами пропавших/появившихся
//                             файлов. Допустимые новые basename читаются из манифеста
//                             .mnemazine/state/vault-hygiene-allowed-new.json — объявление
//                             живет в ДАННЫХ, а не во флаге вызова.
//   --converge                сходимость замерщиков битых wikilink: число от
//                             mnemazine-kb-lint.mjs --json --limit=500 против
//                             независимого грубого обхода ниже. Расхождение → exit 1.
//
// Грубый обход сознательно НЕ исключает graphify-out* — именно этим два замерщика
// расходились до П15 (один считал внутри graphify, другой снаружи). После выноса
// мертвых бэкапов оба обязаны давать одно число; вернувшийся бэкап снова их разводит,
// и --converge обязан упасть (враждебная проба 3 плана П15).
//
// Все обходы — под LC_ALL=C: BSD uniq/sort под en_US.UTF-8 схлопывает разные
// кириллические имена (инвариант 4 мастер-плана).

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveVault as resolveVaultPath } from './mnemazine-paths.mjs'

process.env.LC_ALL = 'C'

const argv = process.argv.slice(2)
function arg(name, fallback = '') {
  const i = argv.indexOf(`--${name}`)
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const eq = argv.find(a => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}
const flag = name => argv.includes(`--${name}`)

const nfc = value => String(value || '').normalize('NFC')

function resolveVault() {
  return resolveVaultPath({ cli: arg('vault'), requireExists: false })
}

const KB_LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mnemazine-kb-lint.mjs')

const ALLOWED_NEW_MANIFEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '.mnemazine', 'state', 'vault-hygiene-allowed-new.json'
)

// Манифест допустимых появлений — единственный канал объявления новых basename.
// Отсутствующий файл = пустой манифест; битый JSON = exit 1 (молчаливого пропуска нет).
async function readAllowedNew() {
  if (!existsSync(ALLOWED_NEW_MANIFEST)) return []
  let doc
  try {
    doc = JSON.parse(await fs.readFile(ALLOWED_NEW_MANIFEST, 'utf8'))
  } catch (err) {
    console.error(`FAIL: манифест допустимых появлений — битый JSON: ${ALLOWED_NEW_MANIFEST} (${err.message})`)
    process.exit(1)
  }
  const list = Array.isArray(doc?.allowed) ? doc.allowed : []
  return list
    .map(entry => ({ basename: nfc(entry?.basename), reason: String(entry?.reason || ''), added: String(entry?.added || '') }))
    .filter(entry => entry.basename)
}

async function writeAllowedNew(entries) {
  const doc = {
    description: 'Манифест допустимых появлений прибора П15 (mnemazine-vault-hygiene-check.mjs --compare). Новый basename в vault считается законным только если он объявлен здесь, с причиной. Любой необъявленный — exit 1 с именем. Флаг --allow-new лишь ДОБАВЛЯЕТ запись в этот файл, обхода сверки нет.',
    allowed: entries
  }
  await fs.mkdir(path.dirname(ALLOWED_NEW_MANIFEST), { recursive: true })
  await fs.writeFile(ALLOWED_NEW_MANIFEST, JSON.stringify(doc, null, 2) + '\n', 'utf8')
}

const SKIP_DIRS = new Set(['.git', '.obsidian', '.mnemazine'])

// --- Обход vault -------------------------------------------------------------
// graphify: 'none'  — повторяет исключения kb-lint (все graphify-out*, 99 Система/_lint).
// graphify: 'extra' — грубый обход для --converge: видит любые graphify-out* КРОМЕ
//                     рабочего graphify-out (его GRAPH_REPORT.md линкует метки кластеров,
//                     а не ноты). Вернувшийся из архива бэкап грубый обход увидит — и
//                     замерщики разойдутся, чего требует враждебная проба 3 плана П15.
// graphify: 'all'   — слепок: видит вообще все.
async function walkVault(vault, { graphify = 'none' } = {}) {
  const md = []
  const dirs = new Set()
  const fileKeys = new Set()
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, item.name)
      const rel = nfc(path.relative(vault, abs).replace(/\\/g, '/'))
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue
        if (item.name.startsWith('graphify-out') && graphify !== 'all' && !(graphify === 'extra' && item.name !== 'graphify-out')) continue
        if (rel === '99 Система/_lint') continue
        dirs.add(rel)
        await walk(abs)
      } else if (item.isFile()) {
        fileKeys.add(rel)
        fileKeys.add(nfc(item.name))
        fileKeys.add(nfc(item.name).replace(/\.md$/i, ''))
        if (item.name.endsWith('.md')) md.push({ abs, rel })
      }
    }
  }
  await walk(vault)
  return { md, dirs, fileKeys }
}

// Код-блоки гасятся пробелами — позиции не едут (та же дисциплина, что в kb-lint).
function scanText(text) {
  return text
    .replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, block => ' '.repeat(block.length))
}

function linkTarget(raw) {
  return nfc(raw.split('|')[0].split('#')[0].split('^')[0].trim().replace(/\\+$/, ''))
}

// --- Независимый грубый замер битых wikilink ---------------------------------
// Отдельная реализация (не импорт kb-lint): разрешение цели через плоское
// множество ключей. Семантика совпадает с kb-lint, код — свой.
async function roughBrokenCount(vault) {
  const wiki = await walkVault(vault, { graphify: 'extra' })
  const resolvable = new Set()
  for (const key of wiki.dirs) resolvable.add(key)
  for (const key of wiki.fileKeys) resolvable.add(key)
  for (const file of wiki.md) {
    const base = nfc(path.basename(file.rel))
    resolvable.add(file.rel.replace(/\.md$/i, ''))
    resolvable.add(base)
    resolvable.add(base.replace(/\.md$/i, ''))
  }
  let broken = 0
  const brokenTargets = new Map()
  const linkRe = /\[\[([^\]\n]+)\]\]/g
  for (const file of wiki.md) {
    const text = scanText(await fs.readFile(file.abs, 'utf8'))
    let match
    while ((match = linkRe.exec(text))) {
      const target = linkTarget(match[1])
      if (!target || target.startsWith('#') || /^(https?|mailto):/i.test(target)) continue
      const base = nfc(path.basename(target))
      const keys = [target, target.replace(/\.md$/i, ''), base, base.replace(/\.md$/i, '')]
      if (keys.some(key => resolvable.has(key))) continue
      broken += 1
      brokenTargets.set(target, (brokenTargets.get(target) || 0) + 1)
    }
  }
  return { count: broken, targets: brokenTargets }
}

// --- Слепок ------------------------------------------------------------------
async function takeSnapshot(vault) {
  const wiki = await walkVault(vault, { graphify: 'all' })
  const files = []
  const weightByTop = new Map()
  let wikilinksInGraphify = 0
  let wikilinksOutGraphify = 0
  const linkRe = /\[\[([^\]\n]+)\]\]/g
  for (const file of wiki.md) {
    const buf = await fs.readFile(file.abs)
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    const text = buf.toString('utf8')
    const occurrences = (text.match(linkRe) || []).length
    const inGraphify = file.rel.split('/').some(part => part.startsWith('graphify-out'))
    if (inGraphify) wikilinksInGraphify += occurrences
    else wikilinksOutGraphify += occurrences
    files.push({ path: file.rel, basename: nfc(path.basename(file.rel)), sha256, bytes: buf.length })
  }
  // Вес по каталогам — все файлы, не только .md.
  async function weigh(dir) {
    let total = 0
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) total += await weigh(abs)
      else if (item.isFile()) total += (await fs.stat(abs).catch(() => ({ size: 0 }))).size
    }
    return total
  }
  for (const item of await fs.readdir(vault, { withFileTypes: true })) {
    const abs = path.join(vault, item.name)
    const bytes = item.isDirectory() ? await weigh(abs) : (await fs.stat(abs).catch(() => ({ size: 0 }))).size
    weightByTop.set(nfc(item.name), bytes)
  }
  const git = spawnSync('git', ['-C', vault, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  const gitStatusPaths = git.status === 0 ? git.stdout.split('\n').filter(Boolean).length : null
  const basenames = [...new Set(files.map(f => f.basename))].sort()
  const snap = {
    tool: 'mnemazine-vault-hygiene-check',
    created_at: new Date().toISOString(),
    vault,
    markdown_files: files.length,
    basenames,
    files: files.sort((a, b) => a.path < b.path ? -1 : 1),
    weight_bytes_by_top: Object.fromEntries([...weightByTop.entries()].sort()),
    wikilinks: { inside_graphify: wikilinksInGraphify, outside_graphify: wikilinksOutGraphify, total: wikilinksInGraphify + wikilinksOutGraphify },
    git_status_paths: gitStatusPaths
  }
  return snap
}

async function snapshot(outPath) {
  const snap = await takeSnapshot(resolveVault())
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify(snap, null, 2) + '\n', 'utf8')
  console.log(`слепок записан: ${outPath}`)
  console.log(`markdown: ${snap.markdown_files}, basename уникальных: ${snap.basenames.length}, git status: ${snap.git_status_paths}`)
  console.log(`wikilinks: внутри graphify ${snap.wikilinks.inside_graphify}, вне ${snap.wikilinks.outside_graphify}`)
}

// --- Сверка before-слепка с ЖИВЫМ диском -------------------------------------
// --compare [before] сверяет before-слепок со свежим срезом vault, который
// снимается самим --compare в момент запуска. До П15b сравнивались два
// СОХРАНЕННЫХ JSON — гейт был слеп к подложке в живом vault, если after-слепок
// не пересняли. Отдельный after-слепок больше не участвует в сверке; при нужде
// живой срез можно вывести побочно через --after-out <file>.
// Fail-closed: нет before-слепка (или он битый) → exit 2, сверка без базиса
// не считается «зеленой».
// Допустимые новые basename живут в манифесте .mnemazine/state/vault-hygiene-allowed-new.json
// и читаются самим --compare, без флагов. --allow-new <a,b,c> [--reason <текст>] —
// НЕ обход: он дописывает записи в манифест, после чего сверка идет по манифесту.
// Любая другая пропажа/появление → exit 1 с именем.
async function compare(beforePath) {
  let before
  try {
    before = JSON.parse(await fs.readFile(beforePath, 'utf8'))
  } catch (err) {
    console.error(`compare FAIL: нет читаемого before-слепка: ${beforePath} (${err.message})`)
    process.exit(2)
  }
  if (!Array.isArray(before?.basenames)) {
    console.error(`compare FAIL: before-слепок без массива basenames: ${beforePath}`)
    process.exit(2)
  }
  const vault = resolveVault()
  if (!existsSync(vault)) {
    console.error(`compare FAIL: живой vault не существует: ${vault}`)
    process.exit(2)
  }
  const after = await takeSnapshot(vault)
  console.log(`живой срез снят с диска: ${vault} (${after.markdown_files} markdown, ${after.basenames.length} уникальных basename)`)
  const afterOut = arg('after-out', '')
  if (afterOut) {
    await fs.mkdir(path.dirname(path.resolve(afterOut)), { recursive: true })
    await fs.writeFile(afterOut, JSON.stringify(after, null, 2) + '\n', 'utf8')
    console.log(`живой срез записан побочно: ${afterOut}`)
  }
  let entries = await readAllowedNew()
  const cliNew = arg('allow-new', '').split(',').map(s => nfc(s.trim())).filter(Boolean)
  if (cliNew.length) {
    const reason = arg('reason', '').trim()
    if (!reason) { console.error('нужен --reason <причина> вместе с --allow-new: объявление без причины не пишется'); process.exit(2) }
    const have = new Set(entries.map(e => e.basename))
    const fresh = cliNew.filter(x => !have.has(x))
    entries = entries.concat(fresh.map(basename => ({ basename, reason, added: new Date().toISOString().slice(0, 10) })))
    if (fresh.length) await writeAllowedNew(entries)
    console.log(`манифест допустимых появлений дополнен (${fresh.length} новых): ${fresh.join(', ') || '—'}`)
  }
  const allowNew = new Set(entries.map(e => e.basename))
  const reasonByName = new Map(entries.map(e => [e.basename, e.reason]))
  const b = new Set(before.basenames)
  const a = new Set(after.basenames)
  const missing = [...b].filter(x => !a.has(x)).sort()
  const added = [...a].filter(x => !b.has(x)).sort()
  const undeclared = added.filter(x => !allowNew.has(x))
  const declared = added.filter(x => allowNew.has(x))
  for (const name of declared) console.log(`ожидаемая новая (манифест): ${name} — ${reasonByName.get(name) || 'без причины'}`)
  if (missing.length === 0 && undeclared.length === 0) {
    console.log(`compare OK: пропавших нет, появившихся сверх объявленных нет (${b.size} имен до)`)
    process.exit(0)
  }
  for (const name of missing) console.log(`ПРОПАЛА: ${name}`)
  for (const name of undeclared) console.log(`ПОЯВИЛАСЬ (не объявлена): ${name}`)
  console.error(`compare FAIL: пропало ${missing.length}, появилось необъявленных ${undeclared.length}`)
  process.exit(1)
}

// --- Сходимость замерщиков ---------------------------------------------------
async function converge() {
  const vault = resolveVault()
  const run = spawnSync(process.execPath, [KB_LINT, '--json', '--limit=500', '--vault', vault], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024
  })
  // kb-lint возвращает 1 при critical-находках — это не ошибка запуска, JSON все равно в stdout.
  const raw = String(run.stdout || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end < start) {
    console.error('converge FAIL: kb-lint не вернул JSON')
    console.error(run.stderr || '')
    process.exit(1)
  }
  const lint = JSON.parse(raw.slice(start, end + 1))
  const lintCount = lint?.checks?.broken_wikilinks?.count
  if (typeof lintCount !== 'number') {
    console.error('converge FAIL: в JSON kb-lint нет checks.broken_wikilinks.count')
    process.exit(1)
  }
  const rough = await roughBrokenCount(vault)
  console.log(`kb-lint:  битых wikilink = ${lintCount}`)
  console.log(`грубый:   битых wikilink = ${rough.count}`)
  if (lintCount === rough.count) {
    console.log('converge OK: замерщики сошлись')
    process.exit(0)
  }
  const lintTargets = new Map((lint.checks.broken_wikilinks.worst || []).map(item => [item.target, item.count]))
  console.error(`converge FAIL: расхождение ${Math.abs(lintCount - rough.count)}`)
  for (const [target, count] of [...rough.targets.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20)) {
    console.error(`  грубый-only/расход: ${target} ×${count} (kb-lint worst: ${lintTargets.get(target) ?? '—'})`)
  }
  process.exit(1)
}

// --- Точка входа -------------------------------------------------------------
if (flag('snapshot')) {
  const out = arg('out', '')
  if (!out) { console.error('нужен --out <file>'); process.exit(2) }
  await snapshot(out)
} else if (arg('compare') || argv[0] === '--compare') {
  const rest = []
  for (let i = argv.indexOf('--compare') + 1; i < argv.length; i++) {
    if (argv[i] === '--allow-new' || argv[i] === '--reason' || argv[i] === '--after-out' || argv[i] === '--vault') { i++; continue }
    if (argv[i].startsWith('--allow-new=') || argv[i].startsWith('--reason=') || argv[i].startsWith('--after-out=')) continue
    if (argv[i].startsWith('--')) continue
    rest.push(argv[i])
  }
  if (rest.length > 1) {
    console.error('лишний позиционный аргумент: --compare [before]. after-слепок больше не участвует в сверке — живой срез снимается с диска самим --compare; побочный вывод — --after-out <file>')
    process.exit(2)
  }
  const beforePath = rest[0] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.mnemazine', 'state', 'vault-hygiene-before.json')
  await compare(beforePath)
} else if (flag('converge')) {
  await converge()
} else {
  console.log(`mnemazine-vault-hygiene-check.mjs — прибор П15
  --snapshot --out <file>        слепок vault (basename, sha256, веса, wikilinks, git status)
  --compare [before]             basename before-слепка против ЖИВОГО диска (срез снимается
                                 самим --compare; иначе exit 1 с именами). Без аргумента before —
                                 .mnemazine/state/vault-hygiene-before.json; нет слепка → exit 2;
                                 допустимые новые — из .mnemazine/state/vault-hygiene-allowed-new.json
  --after-out <file>             (с --compare) записать живой срез побочным слепком
  --allow-new <a,b,c> --reason <текст>   (с --compare) дописать basename в манифест, не обход
  --converge                     kb-lint против грубого обхода: одно число битых wikilink (иначе exit 1)
  --vault <path>                 переопределить vault (дефолт — нейтральный, см. mnemazine-paths.mjs)`)
  process.exit(2)
}
