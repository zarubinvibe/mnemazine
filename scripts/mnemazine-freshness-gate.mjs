#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

if (argv.includes('--help')) {
  console.log(`mnemazine-freshness-gate.mjs — проверка, что новая/измененная нота несет сигнал свежести.

Использование:
  node scripts/mnemazine-freshness-gate.mjs [--vault PATH] [--changed-since ISO] [--json] [--allow-empty]
  node scripts/mnemazine-freshness-gate.mjs --selftest

Гейт требует в блоке "## Достоверность" хотя бы один freshness marker:
  - дату YYYY-MM-DD;
  - ISO-время;
  - "актуально на";
  - "перепроверить";
  - "версия" / "version" / "release" / "updated_at" / "pushed_at".`)
  process.exit(0)
}

const JSON_OUT = argv.includes('--json')
const ALLOW_EMPTY = argv.includes('--allow-empty')
const CHANGED_SINCE = arg('changed-since', '')
const MAX_FAILURES = Number(arg('max-failures', process.env.MNEMAZINE_FRESHNESS_MAX_FAILURES || '0'))

function sinceMs(value) {
  if (!value) return 0
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const CHANGED_SINCE_MS = sinceMs(CHANGED_SINCE)

function isServicePath(rel) {
  return (
    rel.includes('/graphify-out/') ||
    rel.includes('/_legacy-index ') ||
    rel.includes('/_архив-дублей/') ||
    rel.includes('/Capabilities/_') ||
    /^99 Система\//.test(rel) ||
    /^00 System\//.test(rel) ||
    /(^|\/)_(Содержание|МАСТЕР-ИНДЕКС|ROUTING|ШАБЛОНЫ)\.md$/.test(rel) ||
    ['AGENTS.md', 'CLAUDE.md', '_ROUTING.md', 'Лог обработки.md'].includes(rel)
  )
}

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, item.name)
    if (item.isDirectory() && !['.git', '.obsidian'].includes(item.name) && !item.name.startsWith('graphify-out')) {
      out.push(...await walk(file))
    } else if (item.isFile() && file.endsWith('.md')) {
      out.push(file)
    }
  }
  return out
}

function sectionBody(body, headingRe) {
  const lines = String(body || '').split('\n')
  const start = lines.findIndex(line => headingRe.test(line))
  if (start === -1) return null
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

const FRESHNESS_RE = [
  /\b20\d{2}-\d{2}-\d{2}\b/,
  /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/,
  /актуальн[оаы]?\s+на/i,
  /перепровер/i,
  /\b(?:updated_at|pushed_at|published_at|released_at)\b/i,
  /\b(?:version|release|tag|commit|sha-?256)\b/i,
  /\bверси[яию]\b/i,
  /\bрелиз\b/i
]

function freshnessOk(text) {
  const dost = sectionBody(text, /^##\s+Достоверность\s*$/)
  if (dost === null) return { ok: false, reason: 'нет блока «Достоверность»' }
  if (!dost.trim()) return { ok: false, reason: 'блок «Достоверность» пуст' }
  if (!FRESHNESS_RE.some(re => re.test(dost))) {
    return { ok: false, reason: 'нет freshness marker: дата YYYY-MM-DD, версия, updated_at или «перепроверить»' }
  }
  return { ok: true }
}

async function checkVault(vault) {
  const files = await walk(vault)
  const failures = []
  let checked = 0
  for (const file of files) {
    const rel = path.relative(vault, file)
    if (isServicePath(rel)) continue
    const stat = await fs.stat(file)
    if (CHANGED_SINCE_MS && stat.mtimeMs < CHANGED_SINCE_MS) continue
    checked += 1
    const text = await fs.readFile(file, 'utf8')
    const result = freshnessOk(text)
    if (!result.ok) failures.push({ file: rel, marker: result.reason })
    if (MAX_FAILURES > 0 && failures.length >= MAX_FAILURES) break
  }
  return {
    ok: failures.length === 0 && (checked > 0 || ALLOW_EMPTY),
    checked,
    total: files.length,
    scope: CHANGED_SINCE_MS ? { changed_since: new Date(CHANGED_SINCE_MS).toISOString() } : { changed_since: null },
    failures
  }
}

async function selftest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-freshness-'))
  const vault = path.join(temp, 'vault')
  await fs.mkdir(path.join(vault, '01 Concepts'), { recursive: true })
  const good = `# Good

## Короткий ответ
Хорошая нота.

## 🎯 Как это поможет мне
Мнемозина найдет знание.

## Достоверность
- Источник: smoke.
- Актуально на 2026-09-12; перепроверить перед применением.
`
  const bad = `# Bad

## Короткий ответ
Плохая нота.

## 🎯 Как это поможет мне
Мнемозина найдет знание.

## Достоверность
- Источник: smoke без временной отметки.
`
  await fs.writeFile(path.join(vault, '01 Concepts', 'good.md'), good, 'utf8')
  let result = await checkVault(vault)
  if (!result.ok || result.checked !== 1) throw new Error(`freshness selftest good failed: ${JSON.stringify(result)}`)
  await fs.writeFile(path.join(vault, '01 Concepts', 'bad.md'), bad, 'utf8')
  result = await checkVault(vault)
  if (result.ok || result.failures.length !== 1 || result.failures[0].file !== '01 Concepts/bad.md') {
    throw new Error(`freshness selftest bad failed: ${JSON.stringify(result)}`)
  }
  console.log(JSON.stringify({ ok: true, selftest: true }, null, 2))
}

if (argv.includes('--selftest')) {
  selftest().catch(error => {
    console.error(error.message || error)
    process.exit(1)
  })
} else {
  const VAULT = resolveVault({ cli: arg('vault') })
  checkVault(VAULT).then(result => {
    const output = JSON.stringify(result, null, 2)
    if (JSON_OUT || !result.ok) console[result.ok ? 'log' : 'error'](output)
    else console.log(output)
    process.exit(result.ok ? 0 : (result.checked === 0 ? 2 : 1))
  }).catch(error => {
    console.error(error.message || error)
    process.exit(1)
  })
}
