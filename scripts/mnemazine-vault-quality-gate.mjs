#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MIN_CYR_SHARE, SPEC_TYPES, SPEC_SUBJECTS, SPEC_DATA_CLASSES, SPEC_VERIFIED, SPEC_VERIFIED_NORM, TYPE_REQUIRED_FIELDS, normSpecValue } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

if (argv.includes('--help')) {
  console.log(`mnemazine-vault-quality-gate.mjs — гейт качества нот корпуса.
Без --spec: маркеры сырья + обязательные секции. С --spec: строгая проверка NOTE-SPEC.
Только читает корпус, ничего не пишет.

Использование: node scripts/mnemazine-vault-quality-gate.mjs [флаги] [файлы...]
  --vault <путь>      корпус (иначе MNEMAZINE_VAULT или repo-local vault)
  --spec              режим NOTE-SPEC (frontmatter enum, блоки, слаги проектов)
  --json              отчёт в JSON
  --require-dossier   требовать полное досье секций (старый режим)
  --changed-since <время>  проверять только ноты, изменённые после отметки
  --max-failures N    остановиться после N провалов
  --allow-empty       разрешить зелёный на пустом наборе (иначе 0 проверенных — exit 2)
  --help              эта справка

Коды возврата: 0 — чисто; 1 — есть провалы; 2 — пустой набор без --allow-empty
или нечитаемый _ПРОЕКТЫ.md в режиме --spec.`)
  process.exit(0)
}

const VAULT = resolveVault({ cli: arg('vault') })
const SPEC_MODE = argv.includes('--spec')
const JSON_OUT = argv.includes('--json')
const REQUIRE_DOSSIER = argv.includes('--require-dossier')
const CHANGED_SINCE = arg('changed-since', '')
const MAX_FAILURES = Number(arg('max-failures', process.env.MNEMAZINE_QUALITY_MAX_FAILURES || '0'))
// fail-closed: ноль проверенных нот (пустой/нечитаемый vault, или changed-since
// не совпал ни с одним файлом) — это НЕ «сдано 0/0 ✓», а exit 2. Только явный
// --allow-empty разрешает зелёный на пустом наборе.
const ALLOW_EMPTY = argv.includes('--allow-empty')

// Flags whose value is the NEXT argv item — without this list positional
// file arguments are indistinguishable from flag values.
const VALUE_FLAGS = new Set(['--vault', '--changed-since', '--max-failures'])
const FILE_ARGS = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) i += 1
    continue
  }
  FILE_ARGS.push(path.resolve(a))
}

function sinceMs(value) {
  if (!value) return 0
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const CHANGED_SINCE_MS = sinceMs(CHANGED_SINCE)

const badMarkers = [
  /raw\s+ocr/i,
  /сырой\s+ocr(?!\s+исключ[её]н)/i,
  /No extractable text/i,
  /Unextractable local source/i,
  /needs_manual_context/i,
  /распознанный\s+текст\s+без\s+обработки/i,
  /Video keyframe OCR/i,
  /Video transcript from local Whisper/i,
  /intake-draft/i,
  /draft-local/i,
  /локальное\s+извлечение/i,
  /local extraction only/i,
  /\btemp_image[_-]/i,
  /\bIMG_\d+/,
  /\.(WEBP|PNG|JPE?G|HEIC|TIFF)\b/,
  /lorem ipsum/i,
  /TODO:\s*rewrite/i,
  /скриншот\s+без\s+контекста/i
]

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name)
    if (
      item.isDirectory() &&
      !['.git', '.obsidian'].includes(item.name) &&
      !item.name.startsWith('graphify-out')
    ) out.push(...await walk(p))
    else if (item.isFile() && p.endsWith('.md')) out.push(p)
  }
  return out
}

function isServicePath(rel) {
  // «99 Система» — служебная секция живого корпуса владельца; «00 System» — её
  // близнец в свежесобранном (публичном) корпусе, куда install.sh кладёт
  // «Mnemazine Protocol.md». Оба — сервис, не знание: NOTE-SPEC их не судит (П22).
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

// ── NOTE-SPEC (docs/NOTE-SPEC.md проекта mnemazine) — режим --spec ──

// «не-проверялось» добавлено 2026-07-25 по решению владельца: 1235 старых нот пришли без поля verified
// или со значением false, и ни одно из пяти прежних значений не описывает «никто не проверял» — впихнуть
// их в «источник-не-найден» значило бы записать в корпус ложь ради зелёного гейта.
// НОВАЯ нота это значение носить не должна: конвейер верифицирует материал до записи (стадия 3).
// ё/е считаются одной буквой при сравнении: «подтверждён» и «подтвержден» —
// одно слово, а слаги проектов в нотах пишут в обеих орфографиях.
const norm = s => normSpecValue(s)

function unquote(v) {
  const m = v.match(/^"(.*)"$/s) || v.match(/^'(.*)'$/s)
  return m ? m[1] : v
}

// Минимальный YAML-подмножество-парсер: только то, что реально встречается во
// frontmatter нот (скаляры, инлайн- и блок-списки). Незнакомая форма = провал,
// потому что гейт fail-closed. Дубль ключа — провал (дубль YAML-ключа уже был
// измеренной дырой: вторая строка молча побеждает первую).
function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (!/^---\s*$/.test(lines[0] ?? '')) return { error: 'файл не начинается с ---', body: text }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { close = i; break }
  }
  if (close === -1) return { error: 'frontmatter не закрыт второй строкой ---', body: text }
  const body = lines.slice(close + 1).join('\n')
  const data = {}
  let listKey = null
  for (let i = 1; i < close; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = line.match(/^([\w.-]+):(?:\s+(.*))?$/)
    if (kv) {
      const key = kv[1]
      if (Object.hasOwn(data, key)) return { error: `дубль ключа «${key}» во frontmatter`, body }
      const raw = (kv[2] ?? '').trim()
      if (!raw) {
        data[key] = []
        listKey = key
      } else if (/^\[.*\]$/.test(raw)) {
        data[key] = raw.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean)
        listKey = null
      } else {
        data[key] = unquote(raw)
        listKey = null
      }
      continue
    }
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && listKey) {
      data[listKey].push(unquote(item[1].trim()))
      continue
    }
    if (/^\s/.test(line)) continue
    return { error: `непарсибельная строка frontmatter ${i + 1}: «${line.slice(0, 60)}»`, body }
  }
  return { data, body }
}

const scalar = v => (Array.isArray(v) ? '' : String(v ?? '').trim())

function cyrillicShare(body) {
  const prose = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
  const cyr = (prose.match(/[А-Яа-яЁё]/g) || []).length
  const lat = (prose.match(/[A-Za-z]/g) || []).length
  return { cyr, lat, share: cyr + lat ? cyr / (cyr + lat) : 0 }
}

function sectionBody(body, headingRe) {
  const lines = body.split('\n')
  const start = lines.findIndex(l => headingRe.test(l))
  if (start === -1) return null
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

// Источник засчитывается ТОЛЬКО структурно (план П06 шаг 3): непустое значение
// source: во frontmatter ИЛИ заголовок Source/Источник с непустым телом. Голая
// подстрока source: в теле файла, в кодовом блоке или в цитате источником не считается.
function hasStructuredSource(text) {
  const fm = parseFrontmatter(text)
  const fmSource = fm.data?.source
  const fmSourceOk = Array.isArray(fmSource) ? fmSource.some(s => String(s).trim()) : Boolean(scalar(fmSource))
  if (fmSourceOk) return true
  // (?:\s|$), не \b: JS \b — ASCII-only, после кириллицы («Источники») не срабатывает.
  const heading = sectionBody(fm.body ?? text, /^#{2,}\s+(Source|Sources|Источник|Источники)(?:\s|$)/i)
  return heading !== null && heading.trim().length > 0
}

// Слаги проектов — только грепом ## заголовков _ПРОЕКТЫ.md, не хардкод.
// Однословные имена проектов покрыты полным заголовком;
// из многословных дополнительно берутся «кавычечные» имена и латинские токены
// ≥5 символов — кириллические токены («Просто»,
// «партнеры») дают ложные совпадения с обычной прозой, поэтому исключены.
function projectSlugs(text) {
  const slugs = new Set()
  for (const [, h] of text.matchAll(/^##\s+(.+?)\s*$/gm)) {
    slugs.add(norm(h))
    for (const [, q] of h.matchAll(/«([^»]+)»/g)) slugs.add(norm(q))
    for (const t of h.split(/\s+/)) {
      const tok = t.replace(/[«»()"'.,:;]/g, '')
      if (tok.length >= 5 && /[A-Za-z]/.test(tok)) slugs.add(norm(tok))
    }
  }
  return [...slugs]
}

function checkSpec(text, slugs, changedSince = false) {
  const reasons = []
  const fm = parseFrontmatter(text)
  if (fm.error) reasons.push(`frontmatter: ${fm.error}`)
  else {
    const data = fm.data
    const source = data.source
    const sourceOk = Array.isArray(source) ? source.some(s => String(s).trim()) : Boolean(scalar(source))
    if (!sourceOk) reasons.push('source: пуст или отсутствует')
    const type = scalar(data.type)
    if (!SPEC_TYPES.has(type)) reasons.push(`type: «${type || '—'}» вне enum спеки (${[...SPEC_TYPES].join(' | ')})`)
    const verifiedRaw = scalar(data.verified)
    if (!SPEC_VERIFIED_NORM.has(norm(verifiedRaw))) reasons.push(`verified: «${verifiedRaw || '—'}» вне enum спеки (${SPEC_VERIFIED.join(' | ')})`)
    for (const key of TYPE_REQUIRED_FIELDS[type] || []) {
      const v = data[key]
      const ok = Array.isArray(v) ? v.length > 0 : Boolean(scalar(v))
      if (!ok) reasons.push(`type: ${type} требует непустое поле ${key}`)
    }
    // subject (мастер §18): нота различает «факт о мире» и «факт обо мне».
    // (а) значение вне закрытого списка → провал ВСЕГДА;
    // (б) отсутствие поля → провал ТОЛЬКО в проходах с --changed-since (новая нота
    //     обязана нести поле; старый корпус до переогранки П16 за отсутствие не карается);
    // (в) subject: self при source_type video|article|repo → self-нота с чужим источником (§18.4).
    const subject = scalar(data.subject)
    if (subject) {
      if (!SPEC_SUBJECTS.has(subject)) {
        reasons.push(`subject: «${subject}» вне закрытого списка (${[...SPEC_SUBJECTS].join(' | ')})`)
      } else if (subject === 'self') {
        const sourceType = scalar(data.source_type)
        if (['video', 'article', 'repo'].includes(sourceType)) reasons.push(`subject: self при source_type: ${sourceType} — self-нота с чужим источником (§18.4)`)
      }
    } else if (changedSince) {
      reasons.push('subject: отсутствует (обязателен для новой/изменённой ноты)')
    }

    // data_class (§17.8, П24): необязательное; если есть — из закрытого списка
    // config/data-classes.json. Отсутствие дефектом НЕ считается — класс тогда
    // берут правила по разделу и наследование от источника (machine-class-gate).
    const dataClass = scalar(data.data_class)
    if (dataClass && SPEC_DATA_CLASSES && !SPEC_DATA_CLASSES.has(dataClass)) {
      reasons.push(`data_class: «${dataClass}» вне закрытого списка config/data-classes.json (${[...SPEC_DATA_CLASSES].join(' | ')})`)
    }
  }
  const body = fm.body
  const { cyr, lat, share } = cyrillicShare(body)
  if (share < MIN_CYR_SHARE) reasons.push(`кириллица ${(share * 100).toFixed(1)}% прозы (< 30%): ${cyr} кир. против ${lat} лат. букв`)
  const help = sectionBody(body, /^#{2,3}\s+(?:🎯\s*)?Как (?:это )?поможет мне\s*$/)
  if (help === null) reasons.push('нет блока «Как это поможет мне»')
  else {
    const normHelp = norm(help)
    if (!slugs.some(s => normHelp.includes(s))) reasons.push('блок «Как это поможет мне» не упоминает ни один проект из «99 Система/_ПРОЕКТЫ.md»')
  }
  const dost = sectionBody(body, /^##\s+Достоверность\s*$/)
  if (dost === null) reasons.push('нет блока «Достоверность»')
  else if (!dost.trim()) reasons.push('блок «Достоверность» пуст')
  return reasons
}

if (SPEC_MODE) {
  const projectsFile = path.join(VAULT, '99 Система', '_ПРОЕКТЫ.md')
  // fail-closed: файла проектов нет или он нечитаем → exit 2, а не стек-трейс ENOENT
  // и код 1. Без списка слагов гейт не может судить блок «Как это поможет мне».
  let projectsText
  try {
    projectsText = await fs.readFile(projectsFile, 'utf8')
  } catch (error) {
    console.error(`Не прочитан ${projectsFile} (${error.code || error.message}) — режим --spec судить корпус не может`)
    process.exit(2)
  }
  const slugs = projectSlugs(projectsText)
  if (!slugs.length) {
    console.error(`Ни одного ## заголовка в ${projectsFile} — гейт не может судить блок «Как это поможет мне»`)
    process.exit(2)
  }
  let targets = FILE_ARGS
  if (!targets.length) {
    targets = []
    for (const file of await walk(VAULT)) {
      if (isServicePath(path.relative(VAULT, file))) continue
      if (CHANGED_SINCE_MS && (await fs.stat(file)).mtimeMs < CHANGED_SINCE_MS) continue
      targets.push(file)
    }
  }
  const failures = []
  let checked = 0
  for (const file of targets) {
    checked += 1
    const text = await fs.readFile(file, 'utf8')
    // Naming files explicitly means "check these fresh/touched notes", same
    // contract as --changed-since. Without this the subject rule (§18) stayed
    // silent in per-file mode and 64 notes shipped without `subject:`.
    const reasons = checkSpec(text, slugs, CHANGED_SINCE_MS > 0 || FILE_ARGS.length > 0)
    if (reasons.length) {
      failures.push({ file: path.relative(VAULT, file), reasons })
      if (MAX_FAILURES > 0 && failures.length >= MAX_FAILURES) break
    }
  }
  if (checked === 0 && !ALLOW_EMPTY) {
    console.error('vault пуст или нечитаем: 0 проверенных (--allow-empty чтобы разрешить)')
    process.exit(2)
  }
  const report = { ok: failures.length === 0, mode: 'spec', checked, failures }
  if (JSON_OUT) {
    ;(failures.length ? console.error : console.log)(JSON.stringify(report, null, 2))
  } else {
    for (const f of failures) {
      console.error(`FAIL ${f.file}`)
      for (const r of f.reasons) console.error(`  - ${r}`)
    }
    ;(failures.length ? console.error : console.log)(`spec: проверено ${checked}, провалов ${failures.length}`)
  }
  process.exit(failures.length ? 1 : 0)
}

// ── Старый режим (без --spec): маркеры сырья + обязательные секции ──

const files = await walk(VAULT)
const failures = []
let checked = 0
for (const file of files) {
  const stat = await fs.stat(file)
  if (CHANGED_SINCE_MS && stat.mtimeMs < CHANGED_SINCE_MS) continue
  const rel = path.relative(VAULT, file)
  if (isServicePath(rel)) continue
  checked += 1
  const text = await fs.readFile(file, 'utf8')
  // «## Атомизировано» больше НЕ освобождает ноту от суда (план П06 шаг 1):
  // сырьё (badMarkers), отсутствие источника и смыслового блока валят её как любую
  // другую. Единственное смягчение — при --require-dossier такая нота не обязана
  // нести шесть секций старого досье: это другой формат, а не индульгенция.
  const atomized = /^##\s+Атомизировано(?:\s|$)/m.test(text)
  const hit = badMarkers.find(re => re.test(text))
  const hasSource = hasStructuredSource(text)
  const hasMeaning = /#{2,}\s+(What This Is|Что это|Что это и зачем|Суть|Полное объяснение|Короткий ответ|Короткий вывод|Кратко|Главное|Главный вывод)(?:\s|$)/i.test(text)
  const missingDossier = (REQUIRE_DOSSIER && !atomized)
    ? [
        ['Короткий ответ', /^##\s+Короткий ответ(?:\s|$)/m],
        ['Полное объяснение', /^##\s+Полное объяснение(?:\s|$)/m],
        ['Как использовать', /^##\s+Как использовать(?:\s|$)/m],
        ['Ошибки и ограничения', /^##\s+Ошибки и ограничения(?:\s|$)/m],
        ['Достоверность', /^##\s+Достоверность(?:\s|$)/m],
        ['Атомизация', /^##\s+Атомизация(?:\s|$)/m],
      ].filter(([, re]) => !re.test(text)).map(([name]) => name)
    : []
  if (hit || !hasSource || !hasMeaning || missingDossier.length) {
    failures.push({ file: rel, marker: hit ? String(hit) : missingDossier.length ? `missing dossier sections: ${missingDossier.join(', ')}` : 'missing required sections' })
    if (MAX_FAILURES > 0 && failures.length >= MAX_FAILURES) break
  }
}

if (checked === 0 && !ALLOW_EMPTY) {
  console.error('vault пуст или нечитаем: 0 проверенных (--allow-empty чтобы разрешить)')
  process.exit(2)
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, checked, total: files.length, scope: CHANGED_SINCE_MS ? { changed_since: new Date(CHANGED_SINCE_MS).toISOString() } : { changed_since: null }, failures }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({ ok: true, checked, total: files.length, scope: CHANGED_SINCE_MS ? { changed_since: new Date(CHANGED_SINCE_MS).toISOString() } : { changed_since: null } }, null, 2))
