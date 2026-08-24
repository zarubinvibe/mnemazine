#!/usr/bin/env node
// Machine-class barrier (П24). The router (П04) answers "which CLI may SEE a
// class"; this gate answers "which MACHINE may PROCESS a note" — the second
// border, same single truth: config/data-classes.json (rule 8 of the method).
//
// A note's class is the MAX over the order among all fired rules (strict wins):
//   1. explicit `data_class:` in frontmatter  — may RAISE, never LOWER
//   2. by_section[section]                     — section field or parent-dir name
//   3. source inheritance                      — projects∈by_project | source∈by_source_pattern
// No rule fired: a KNOWN section (the section name is a real directory in the
// note's own path) → text (ordinary material, VPS-ok); an UNKNOWN/new section
// → exit 2 (a new section can't silently become sendable); broken/absent
// frontmatter → default (personal) → the batch reddens with 1.
//
// Exit codes:
//   --classify <file>            0 class printed with the firing rule · 2 undeterminable
//   --batch <manifest> --target  0 clean · 1 a class blocked on target (names first) · 2 undeterminable/empty
//   --selftest                   0 fixtures pass · 1 a fixture disagrees
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const TAXONOMY_PATH = path.join(HERE, '..', 'config', 'data-classes.json')
const FIXTURES = path.join(HERE, '..', 'tests', 'fixtures', 'data-classes')

export function loadTaxonomy(file = TAXONOMY_PATH) {
  const t = JSON.parse(readFileSync(file, 'utf8'))
  for (const k of ['order', 'classes', 'by_section', 'by_project', 'by_source_pattern', 'default']) {
    if (!(k in t)) throw new Error(`config/data-classes.json: нет поля ${k}`)
  }
  return t
}

function unquote(s) { return s.replace(/^["']/, '').replace(/["']$/, '') }

// Minimal frontmatter reader: the block between the first `---` and the next
// `---`. Absent block or no closing fence → not ok (fail-closed to default).
export function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return { ok: false }
  let end = -1
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { end = i; break } }
  if (end === -1) return { ok: false }
  const fields = { projects: [], sources: [] }
  let listKey = null
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\s+$/, '')
    if (listKey && /^\s*-\s+/.test(line)) { fields[listKey].push(unquote(line.replace(/^\s*-\s+/, '').trim())); continue }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!m) { listKey = null; continue }
    const key = m[1]; const val = m[2].trim(); listKey = null
    if (val === '') { if (key === 'projects' || key === 'sources') listKey = key; continue }
    if ((key === 'projects' || key === 'sources') && val.startsWith('[')) {
      fields[key] = val.replace(/^\[/, '').replace(/\]$/, '').split(',').map(s => unquote(s.trim())).filter(Boolean)
      continue
    }
    if (key === 'data_class') fields.data_class = unquote(val)
    else if (key === 'section') fields.section = unquote(val)
    else if (key === 'source') fields.source = unquote(val)
  }
  return { ok: true, fields }
}

const firstSegment = sec => sec.split('/')[0].trim()

function bySectionMatch(sec, taxonomy) {
  for (const key of Object.keys(taxonomy.by_section)) {
    if (sec === key || firstSegment(sec) === key) return { klass: taxonomy.by_section[key], key }
  }
  return null
}

function sourceInherit(fields, taxonomy) {
  const fired = []
  for (const proj of fields.projects || []) {
    if (taxonomy.by_project[proj]) fired.push({ klass: taxonomy.by_project[proj], rule: `by_project «${proj}»` })
  }
  const srcs = [fields.source, ...(fields.sources || [])].filter(Boolean)
  for (const [pat, klass] of Object.entries(taxonomy.by_source_pattern)) {
    const re = new RegExp(pat)
    if (srcs.some(s => re.test(s))) fired.push({ klass, rule: `by_source_pattern «${pat}»` })
  }
  return fired
}

// Pure classification. `sec` is the resolved section; `knownSections` is a Set
// of names treated as existing vault sections. Returns { klass, rule } or
// { undetermined: true, section } for a new/unknown section.
export function classifyNote(fields, sec, taxonomy, knownSections) {
  const rank = k => taxonomy.order.indexOf(k)
  const fired = []
  if (fields.data_class) {
    if (!taxonomy.classes[fields.data_class]) return { undetermined: true, section: sec, badClass: fields.data_class }
    fired.push({ klass: fields.data_class, rule: 'data_class (явное поле)' })
  }
  if (sec) { const m = bySectionMatch(sec, taxonomy); if (m) fired.push({ klass: m.klass, rule: `by_section «${m.key}»` }) }
  for (const r of sourceInherit(fields, taxonomy)) fired.push(r)

  if (fired.length) {
    fired.sort((a, b) => rank(b.klass) - rank(a.klass)) // max by order — strict wins
    return { klass: fired[0].klass, rule: fired[0].rule }
  }
  if (sec) {
    if (knownSections.has(firstSegment(sec))) return { klass: 'text', rule: `известный раздел «${firstSegment(sec)}» без спец-правила → text` }
    return { undetermined: true, section: sec } // new/unknown section → exit 2
  }
  return { klass: taxonomy.default, rule: `default (${taxonomy.default})` }
}

// A note's "known sections" are self-located: the directory names in its own
// path. A section is real iff the note physically lives inside a dir of that
// name — no config, no hardcoded vault name (public-release safe). Selftest
// injects a fixed set so it stays hermetic. `sec` defaults to the parent dir.
export function classifyFile(filePath, taxonomy, knownOverride) {
  let text
  try { text = readFileSync(filePath, 'utf8') } catch { return { undetermined: true, section: null, reason: `файл не прочитан: ${filePath}` } }
  const fm = parseFrontmatter(text)
  if (!fm.ok) return { klass: taxonomy.default, rule: `битый/отсутствующий frontmatter → default (${taxonomy.default})` }
  const abs = path.resolve(filePath)
  const sec = fm.fields.section || path.basename(path.dirname(abs))
  const known = knownOverride || new Set(path.dirname(abs).split(path.sep))
  return classifyNote(fm.fields, sec, taxonomy, known)
}

// --- CLI modes ---------------------------------------------------------------

function runClassify(file, taxonomy) {
  const res = classifyFile(file, taxonomy)
  if (res.undetermined) {
    console.error(`НЕ ОПРЕДЕЛЁН: ${res.badClass ? `неизвестный класс «${res.badClass}»` : `раздел вне таксономии «${res.section}»`} (${path.basename(file)})`)
    return 2
  }
  console.log(`${res.klass}  (правило: ${res.rule})`)
  return 0
}

function runBatch(manifest, target, taxonomy) {
  if (!['mac', 'vps'].includes(target)) { console.error(`--target должен быть mac|vps, получено: ${target}`); return 2 }
  let raw
  try { raw = readFileSync(manifest, 'utf8') } catch { console.error(`манифест не прочитан: ${manifest}`); return 2 }
  const files = raw.split('\n').map(s => s.trim()).filter(Boolean)
  if (!files.length) { console.error('пустой манифест — 0 нот, это отказ, а не «проверено 0 ✓»'); return 2 }

  const undetermined = []
  const blocked = []
  for (const f of files) {
    const res = classifyFile(f, taxonomy)
    if (res.undetermined) { undetermined.push({ f, res }); continue }
    if (!taxonomy.classes[res.klass].machines.includes(target)) blocked.push({ f, res })
  }
  if (undetermined.length) {
    const { f, res } = undetermined[0]
    console.error(`ОТКАЗ (2): класс не определяется — ${res.badClass ? `неизвестный класс «${res.badClass}»` : `раздел вне таксономии «${res.section}»`} в ${f}`)
    return 2
  }
  if (blocked.length) {
    const { f, res } = blocked[0]
    console.error(`ОТКАЗ (1): ${f} — класс ${res.klass} (${res.rule}) не разрешён на ${target} (разрешено: ${taxonomy.classes[res.klass].machines.join(',')})`)
    console.error(`всего заблокировано: ${blocked.length} из ${files.length}`)
    return 1
  }
  console.log(`чисто: ${files.length} нот, все разрешены на ${target}`)
  return 0
}

// --- selftest (hermetic: injected knownSections, no disk beyond fixtures) -----
function selftest(taxonomy) {
  const known = new Set(['08 AI и Инструменты', '01 Право и Юриспруденция', '02 Здоровье'])
  const cf = f => classifyFile(path.join(FIXTURES, f), taxonomy, known)
  const cases = [
    ['no-field.md', r => r.klass === 'text', 'известный раздел без правила → text'],
    ['pd-section.md', r => r.klass === 'pd', 'by_section → pd'],
    ['personal-section.md', r => r.klass === 'personal', 'by_section → personal'],
    ['explicit-raise.md', r => r.klass === 'pd', 'явное поле поднимает text→pd'],
    ['lower-trap.md', r => r.klass === 'pd', 'явное data_class:text НЕ опускает pd (строгое побеждает)'],
    ['inherit-source.md', r => r.klass === 'pd', 'by_source_pattern → pd'],
    ['inherit-project.md', r => r.klass === 'pd', 'by_project → pd'],
    ['unknown-section.md', r => r.undetermined === true, 'раздел вне таксономии → undetermined(2)'],
    ['broken-frontmatter.md', r => r.klass === 'personal', 'битый frontmatter → default personal']
  ]
  const fail = []
  for (const [file, ok, why] of cases) {
    let r
    try { r = cf(file) } catch (e) { fail.push(`${file}: бросил ${e.message}`); continue }
    if (!ok(r)) fail.push(`${file}: ${why} — получено ${JSON.stringify(r)}`)
  }
  // batch-level semantics on the same fixtures
  const batch = (fileList, target) => {
    const und = [], blk = []
    for (const f of fileList) {
      const res = classifyFile(path.join(FIXTURES, f), taxonomy, known)
      if (res.undetermined) { und.push(res); continue }
      if (!taxonomy.classes[res.klass].machines.includes(target)) blk.push(res)
    }
    return und.length ? 2 : blk.length ? 1 : 0
  }
  if (batch(['no-field.md'], 'vps') !== 0) fail.push('batch: чистая (text) на vps должна быть 0')
  if (batch(['pd-section.md'], 'vps') !== 1) fail.push('batch: pd на vps должна быть 1')
  if (batch(['pd-section.md'], 'mac') !== 0) fail.push('batch: pd на mac должна быть 0')
  if (batch(['personal-section.md'], 'vps') !== 1) fail.push('batch: personal на vps должна быть 1')
  if (batch(['unknown-section.md'], 'vps') !== 2) fail.push('batch: unknown-section должна быть 2')

  if (fail.length) { console.error('selftest ПРОВАЛ:\n' + fail.join('\n')); return 1 }
  console.log(JSON.stringify({ ok: true, selftest: 'machine-class-gate', fixtures: cases.length }))
  return 0
}

function main() {
  const { values } = parseArgs({
    options: {
      classify: { type: 'string' },
      batch: { type: 'string' },
      target: { type: 'string' },
      selftest: { type: 'boolean', default: false }
    },
    allowPositionals: false
  })
  let taxonomy
  try { taxonomy = loadTaxonomy() } catch (e) { console.error(`ОТКАЗ (2): ${e.message}`); return 2 }

  if (values.selftest) return selftest(taxonomy)
  if (values.classify) return runClassify(values.classify, taxonomy)
  if (values.batch) return runBatch(values.batch, values.target || '', taxonomy)
  console.error('использование: --classify <файл> | --batch <манифест> --target mac|vps | --selftest')
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
