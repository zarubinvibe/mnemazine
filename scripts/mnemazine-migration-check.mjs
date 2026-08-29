#!/usr/bin/env node
// Прибор миграционного контракта (план П16, шаг 1).
//
// Контракт — машинная таблица «старое поле → новое поле → правило переноса → что требует человека»,
// чтобы перенос старых полей описывался таблицей, а не 1948 отдельными суждениями модели.
// Контракт покрывает ВСТРЕЧЕННОЕ МНОЖЕСТВО значений, которое --emit переизвлекает на момент запуска,
// а не исторические числа из планов.
//
//   --emit   <json> [--report <md>]  переснять множество из корпуса и переписать контракт (+ человекочитаемую таблицу)
//   --verify <json>                  каждое встреченное значение либо покрыто правилом, либо помечено «требует человека»
//
// verify — fail-closed: поле/значение, встреченное в корпусе и не покрытое контрактом, — exit 1.
// Покрытие трех видов: значение уже в enum спеки (already-conformant), детерминированное правило
// (mapType/mapVerified из mnemazine-normalize-old-frontmatter.mjs — импорт, копий нет) или явная
// пометка human_required. verification_status схлопывается в verified: по решению оркестратора:
// одно значение смысла — одно поле правды; verification_status после миграции удаляется.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SPEC_TYPES, SPEC_VERIFIED, SPEC_SUBJECTS, normSpecValue } from './mnemazine-note-spec.mjs'
import { resolveVault, ROOT } from './mnemazine-paths.mjs'
import { mapType, mapVerified, corpusFiles, readFrontmatter } from './mnemazine-normalize-old-frontmatter.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}
const VAULT = resolveVault({ cli: arg('vault') })
const EMIT = arg('emit')
const VERIFY = arg('verify')
const REPORT = arg('report')
if (!EMIT && !VERIFY) {
  console.error('нужен --emit <json> [--report <md>] или --verify <json>')
  process.exit(2)
}

const norm = v => normSpecValue(String(v ?? '').trim())
const CANON_VERIFIED_NORM = new Set(SPEC_VERIFIED.map(norm))

/** Тело секции `## Источники`/`## Source` (для строки контракта про source). */
function sourcesSectionBody(text) {
  const m = text.match(/^#{2,}\s+(?:Source|Sources|Источник|Источники)\s*$/im)
  if (!m) return ''
  const tail = text.slice(m.index + m[0].length)
  const next = tail.search(/\n##\s+/)
  return (next === -1 ? tail : tail.slice(0, next)).trim()
}

/** Снимок встреченного множества: значение → число нот, по каждому отслеживаемому полю. */
async function scanCorpus() {
  const files = await corpusFiles(VAULT)
  const fields = { type: new Map(), verified: new Map(), verification_status: new Map(), type_legacy: new Map() }
  let withFm = 0
  let noFm = 0
  let sourcesBodyWithEmptySource = 0
  const bump = (map, value) => map.set(value, (map.get(value) || 0) + 1)
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const fm = readFrontmatter(text)
    if (fm.error) { noFm++; continue }
    withFm++
    for (const key of Object.keys(fields)) {
      const v = fm.data[key]
      if (v === undefined) continue
      const value = Array.isArray(v) ? v.join(', ') : String(v)
      bump(fields[key], value)
    }
    const src = fm.data.source
    const srcOk = Array.isArray(src) ? src.some(s => String(s).trim()) : Boolean(String(src ?? '').trim())
    if (!srcOk && sourcesSectionBody(text)) sourcesBodyWithEmptySource++
  }
  return { files: files.length, withFm, noFm, fields, sourcesBodyWithEmptySource }
}

const HUMAN = 'human'
const RULE = 'rule'
const CONFORM = 'already-conformant'
const STANDING_LEGACY_VALUES = {
  type: [
    { value: 'knowledge-note', notes: 38, covered_by: RULE, maps_to: 'concept', reason: 'repo-local fixture/default selftest; знание/заметка без спецполей = concept' },
    { value: 'knowledge-digest', notes: 1, covered_by: RULE, maps_to: 'synthesis', reason: 'repo-local fixture/default selftest; digest/сводка = synthesis' },
  ],
  verified: [
    { value: 'expanded with public sources', notes: 23, covered_by: RULE, maps_to: 'подтвержден', reason: 'repo-local fixture/default selftest; публичные источники уже добавлены' },
    { value: 'false', notes: 15, covered_by: RULE, maps_to: 'не-проверялось', reason: 'repo-local fixture/default selftest; false не заявляет проверку' },
  ],
}

export function mapVerificationStatus(old) {
  const v = norm(old)
  if (!v || ['unknown', 'assumed', 'false', 'no', 'нет', 'null', 'undefined'].includes(v)) return { value: 'не-проверялось', keepLegacy: false }
  if (v.includes('частично')) return { value: 'не-проверялось', keepLegacy: true }
  if (v === 'verified' || v === 'verified-with-public-sources' || /^подтвержд/.test(v)) return { value: 'подтвержден', keepLegacy: v !== 'verified' }
  if (v === 'источник-не-найден') return { value: 'источник-не-найден', keepLegacy: false }
  if (v === 'непроверяемо-методом') return { value: 'непроверяемо-методом', keepLegacy: false }
  return { value: 'не-проверялось', keepLegacy: true }
}

function targetValue(field, value) {
  if (field === 'type') return SPEC_TYPES.has(String(value).trim()) ? String(value).trim() : mapType(value, {})
  if (field === 'verified') return mapVerified(value).value
  if (field === 'verification_status') return mapVerificationStatus(value).value
  return null
}

/** Классификация значения: enum спеки / правило прибора / только человек. */
function classify(field, value) {
  const v = norm(value)
  if (field === 'type') {
    if (SPEC_TYPES.has(String(value).trim())) return CONFORM
    const mapped = mapType(value, {})
    if (SPEC_TYPES.has(mapped) && mapped !== 'tool-card' && mapped !== 'decision') return RULE
    return HUMAN
  }
  if (field === 'verified') {
    if (CANON_VERIFIED_NORM.has(v)) return CONFORM
    const m = mapVerified(value)
    if (!m.keepLegacy) return RULE // пусто/false/true — чистое переименование без потери
    if (m.value === 'не-проверялось') return HUMAN // свободный текст схлопнут с потерей — человек читает legacy
    return RULE
  }
  if (field === 'verification_status') return RULE
  if (field === 'type_legacy') return 'archaeology'
  return HUMAN
}

const RULE_TEXT = {
  type: 'mapType: суффиксное отображение в SPEC_TYPES, умолчание concept; tool-card — только при непустых repo+stars+license+risk; decision механически не ставится; оригинал сохраняется в type_legacy',
  verified: 'mapVerified: значение→SPEC_VERIFIED (е/е равны); аннотация через пробел/скобку → enum + оригинал в verified_legacy; true/да/подтвержд* и expanded with public sources → подтвержден; пусто/false → не-проверялось; свободный текст → не-проверялось + verified_legacy',
  verification_status: 'mapVerificationStatus: поле схлопывается в verified: и после миграции удаляется. Частичная проверка → не-проверялось + legacy; verified/подтвержд*/verified-with-public-sources → подтвержден; unknown/assumed/false/пусто → не-проверялось; источник-не-найден и непроверяемо-методом сохраняют одноименные значения. Правило 8 мастера: два поля одной семантики = дубль правды.',
  type_legacy: 'Археология переогранки — НЕ ТРОГАТЬ: это вход для кампании 3 (legacy-значение говорит о ноте больше, чем выровненный concept) и страховка от неверного отображения.',
  '## Источники→source': 'Перенос в source:/sources: ТОЛЬКО если провенанс виден в самой ноте (basename интейк-файла, local-media:<hash>, URL → в sources:). Не виден — поле остается пустым, нота уходит в список следующей волны. source: НЕ ВЫДУМЫВАТЬ (kimi-master.md, кампания 2).',
}

async function emit() {
  const snap = await scanCorpus()
  const mkField = (field, extra = {}) => {
    const values = [...snap.fields[field].entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, notes]) => {
        const row = { value, notes, covered_by: classify(field, value) }
        const mapped = targetValue(field, value)
        if (mapped !== null) row.maps_to = mapped
        if (field === 'verification_status') row.remove_field_after_migration = true
        return row
      })
    const human = values.filter(v => v.covered_by === HUMAN).map(v => ({ value: v.value, notes: v.notes, reason: RULE_TEXT[field] }))
    return {
      old_field: field,
      new_field: extra.new_field ?? field,
      notes: values.reduce((a, v) => a + v.notes, 0),
      distinct_values: values.length,
      rule: RULE_TEXT[field],
      implemented_by: extra.implemented_by ?? null,
      new_enum: extra.new_enum ?? null,
      decision: extra.decision ?? null,
      values,
      standing_legacy_values: (STANDING_LEGACY_VALUES[field] || []).filter(v => !values.some(row => norm(row.value) === norm(v.value))),
      human_required: human,
    }
  }
  const contract = {
    contract: 'migration-contract',
    contract_version: 1,
    spec_ref: 'docs/NOTE-SPEC.md',
    spec_version: 'NOTE-SPEC 2026-07-25 + subject §18 (2026-08-22)',
    schema_ref: 'scripts/mnemazine-note-spec.mjs (единая правда П05; config/note.schema.json П06 — когда появится, ссылаться на нее, не дублировать)',
    generated_by: 'scripts/mnemazine-migration-check.mjs --emit',
    generated_at: new Date().toISOString(),
    vault: VAULT,
    corpus: { files: snap.files, with_frontmatter: snap.withFm, without_frontmatter: snap.noFm },
    fields: [
      mkField('type', { implemented_by: 'scripts/mnemazine-normalize-old-frontmatter.mjs (mapType)', new_enum: [...SPEC_TYPES] }),
      mkField('verified', { implemented_by: 'scripts/mnemazine-normalize-old-frontmatter.mjs (mapVerified)', new_enum: SPEC_VERIFIED }),
      mkField('verification_status', {
        new_field: 'verified',
        implemented_by: 'scripts/mnemazine-migration-check.mjs (mapVerificationStatus; контракт П16)',
        new_enum: SPEC_VERIFIED,
        decision: 'owner-decided-collapse-into-verified-remove-field',
      }),
      mkField('type_legacy', { new_field: '—' }),
      {
        old_field: '## Источники (тело) при пустом source:',
        new_field: 'source: / sources:',
        notes: snap.sourcesBodyWithEmptySource,
        distinct_values: null,
        rule: RULE_TEXT['## Источники→source'],
        implemented_by: 'кампания 3 (переогранка головой) + scripts/mnemazine-normalize-old-frontmatter.mjs (перенос sources→source)',
        new_enum: null,
        decision: null,
        values: [],
        human_required: [],
      },
    ],
    subject_field: {
      note: 'Поле subject (§18): enum self|world|mixed. Старый корпус проставляется при переогранке: source_type video|article|repo и нет первого лица в теле → world; не выводится однозначно → mixed (fail-closed); self руками не назначается.',
      enum: [...SPEC_SUBJECTS],
    },
  }
  const target = path.resolve(ROOT, EMIT)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(contract, null, 2) + '\n')
  console.log(`контракт записан: ${target}`)
  for (const f of contract.fields) {
    console.log(`  ${f.old_field}: нот ${f.notes}, значений ${f.distinct_values ?? '—'}, человека требует ${f.human_required.length}`)
  }
  console.log(`  ## Источники при пустом source:: нот ${snap.sourcesBodyWithEmptySource}`)
  if (REPORT) {
    const md = renderMarkdown(contract)
    const mdTarget = path.resolve(ROOT, REPORT)
    await fs.mkdir(path.dirname(mdTarget), { recursive: true })
    await fs.writeFile(mdTarget, md)
    console.log(`отчет записан: ${mdTarget}`)
  }
}

function renderMarkdown(c) {
  const rows = []
  for (const f of c.fields) {
    const human = f.human_required.length
      ? f.human_required.map(h => `«${h.value}» (${h.notes})`).join(', ')
      : (f.decision === 'owner-pending' ? 'все поле целиком — решение владельца' : '—')
    rows.push(`| \`${f.old_field}\` | ${f.notes} | ${f.distinct_values ?? '—'} | \`${f.new_field}\` | ${f.rule.split('.')[0]} | ${human} |`)
  }
  return `# Миграционный контракт корпуса → NOTE-SPEC

Сгенерировано кодом: \`${c.generated_by}\`, ${c.generated_at}. Не править руками — переснимать \`--emit\`.
Спека: \`${c.spec_ref}\` (${c.spec_version}). Единая правда состава типов/значений: \`${c.schema_ref}\`.
Корпус при съеме: ${c.corpus.files} файлов, frontmatter есть у ${c.corpus.with_frontmatter}, нет у ${c.corpus.without_frontmatter}.

| Старое поле | Нот | Значений | Новое поле | Правило переноса | Требует человека |
|---|---:|---:|---|---|---|
${rows.join('\n')}

## Полные правила

${c.fields.map(f => `### \`${f.old_field}\`\n\n${f.rule}\n\nПрибор: ${f.implemented_by ?? '—'}.${f.new_enum ? `\nНовый enum: ${f.new_enum.join(' | ')}.` : ''}${f.decision ? `\n**Решение: ${f.decision}.**` : ''}`).join('\n\n')}

## Standing legacy mappings

${c.fields.flatMap(f => (f.standing_legacy_values || []).map(v => `- \`${f.old_field}\`: \`${v.value}\` (${v.notes}) → \`${v.maps_to}\` — ${v.reason}`)).join('\n') || '—'}

## subject (§18 мастер-плана)

${c.subject_field.note}

## Проверка покрытия

\`node scripts/mnemazine-migration-check.mjs --verify config/migration-contract.json\` — каждое значение,
встреченное в корпусе на момент прогона, либо уже в enum спеки, либо покрыто детерминированным правилом,
либо явно помечено «требует человека». Новое непокрытое значение = exit 1.
`
}

async function verify() {
  const target = path.resolve(ROOT, VERIFY)
  const contract = JSON.parse(await fs.readFile(target, 'utf8'))
  const snap = await scanCorpus()
  const problems = []
  const byField = new Map(contract.fields.map(f => [f.old_field, f]))
  for (const field of ['type', 'verified', 'verification_status', 'type_legacy']) {
    const encountered = snap.fields[field]
    const encounteredNotes = [...encountered.values()].reduce((a, b) => a + b, 0)
    if (encounteredNotes === 0) continue
    const row = byField.get(field)
    if (!row) {
      problems.push(`${field}: ${encounteredNotes} нот несут поле, не покрытое контрактом (строка отсутствует)`)
      continue
    }
    if (field === 'type_legacy') continue // археология: покрытие — сама строка с правилом «не трогать»
    const declared = new Map()
    for (const v of [...(row.values || []), ...(row.standing_legacy_values || [])]) declared.set(norm(v.value), v)
    for (const h of row.human_required || []) declared.set(norm(h.value), { value: h.value, covered_by: HUMAN })
    for (const [value, notes] of encountered) {
      const kind = classify(field, value)
      if (kind === CONFORM || kind === 'archaeology') continue // уже в enum спеки
      const decl = declared.get(norm(value))
      if (!decl) {
        problems.push(`${field}: значение «${value}» (${notes} нот) встречено в корпусе, но в контракте не объявлено`)
      } else if (decl.covered_by === HUMAN && kind !== HUMAN) {
        problems.push(`${field}: значение «${value}» помечено «требует человека», но правило покрывает его детерминированно — контракт устарел, пересними --emit`)
      } else if (decl.covered_by === RULE && kind === HUMAN) {
        problems.push(`${field}: значение «${value}» объявлено покрытым правилом, но правило его не покрывает — нужна пометка «требует человека»`)
      }
    }
  }
  if (problems.length) {
    console.error(`контракт НЕ покрывает корпус (${problems.length} проблем):`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`контракт покрывает встреченное множество: ${snap.files} файлов, поля type/verified/verification_status/type_legacy проверены`)
  process.exit(0)
}

if (EMIT) await emit()
else await verify()
