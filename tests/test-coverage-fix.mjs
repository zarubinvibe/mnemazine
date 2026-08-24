// TDD/характеризационный тест фикса покрытия группировки (kb-pipeline).
// Доказывает: (1) gap-split верно делит provenance vs real; (2) НОВАЯ проверка
// покрытия (basename где угодно во frontmatter) ловит склеенные файлы, а СТАРАЯ
// (точно "source: <file>") их теряет — это и был баг.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = p => p.split('/').pop()
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ok  -', m) } else { fail++; console.error('  FAIL-', m) } }

// ---- логика из kb-pipeline.js (закрытие-дыр), скопирована дословно ----
function splitGaps (units, processResults, unaccounted) {
  const notePathByFile = {}
  units.forEach(function (u) {
    const res = processResults.find(function (r) { return r && r.group_id === u.group_id && r.outcome === 'note' })
    if (res) (u.files || []).forEach(function (uf) { notePathByFile[base(uf)] = res.note_md || res.filename || '' })
  })
  const provenanceGaps = unaccounted.filter(function (f) { return notePathByFile[base(f)] })
  const realGaps = unaccounted.filter(function (f) { return !notePathByFile[base(f)] })
  return { provenanceGaps, realGaps }
}

console.log('TEST 1 — gap-split (группа дала ноту → provenance; не дала → real)')
{
  const units = [
    { group_id: 'g1', files: ['/in/a.webp', '/in/b.webp', '/in/c.webp'] }, // 1 юнит, 3 файла
    { group_id: 'g2', files: ['/in/d.webp'] }                               // юнит без ноты
  ]
  const pr = [{ group_id: 'g1', outcome: 'note', note_md: '/v/note1.md' }]  // g1 дал ноту, g2 нет
  const un = ['/in/b.webp', '/in/c.webp', '/in/d.webp']                     // сверщик счёл «дырами»
  const { provenanceGaps, realGaps } = splitGaps(units, pr, un)
  ok(JSON.stringify(provenanceGaps) === JSON.stringify(['/in/b.webp', '/in/c.webp']), 'provenance = b,c (дёшево патчатся)')
  ok(JSON.stringify(realGaps) === JSON.stringify(['/in/d.webp']), 'real = d (идёт в Sonnet-ресёрч)')
}

console.log('TEST 2 — покрытие: НОВАЯ ловит склеенные, СТАРАЯ теряет (=баг)')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbcov-'))
  // склеенная нота группы: source = первый, sources = все 3
  fs.writeFileSync(path.join(dir, 'note1.md'), '---\nsource: a.webp\nsources:\n  - a.webp\n  - b.webp\n  - c.webp\n---\n# знание\n')
  fs.writeFileSync(path.join(dir, 'note2.md'), '---\nsource: x.webp\n---\n# одиночка\n')
  const blobs = fs.readdirSync(dir).map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8') })
  const newCov = function (bn) { return blobs.some(function (c) { return c.includes(bn) }) }            // basename где угодно во frontmatter
  const oldCov = function (bn) { return blobs.some(function (c) { return c.includes('source: ' + bn) }) } // точная строка source:
  for (const bn of ['a.webp', 'b.webp', 'c.webp', 'x.webp']) ok(newCov(bn), 'НОВАЯ покрывает ' + bn)
  ok(oldCov('a.webp') && oldCov('x.webp'), 'СТАРАЯ покрывает первичные a,x')
  ok(!oldCov('b.webp') && !oldCov('c.webp'), 'СТАРАЯ ТЕРЯЕТ склеенные b,c → ложные дыры (баг воспроизведён)')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('TEST 3 — durable-архив: нет авто-удаления исходников (анти-регрессия)')
{
  const HOME = os.homedir()
  const files = [
    HOME + '/.claude/workflows/mnemazina-pipeline.js',
    HOME + '/.codex/workflows/mnemazina-pipeline.js',
    HOME + '/.claude/agents/mnemazina-pipeline/mnemazina-guard.md',
    HOME + '/.codex/agents/mnemazina-pipeline/mnemazina-guard.md'
  ]
  const ARCHIVE_TOKEN = /ARCHIVE|_archive|archivePath|archiveDir|kb-processed-source/
  const DELETE_OP = /-delete\b|\brm\s+-[rf]/
  const RETENTION = /-mtime\s+\+\s*\d+\s+-delete/  // тот самый паттерн ретеншна, что тихо удалял оригиналы
  let checked = 0
  const violations = []
  files.forEach(function (fp) {
    let txt
    try { txt = fs.readFileSync(fp, 'utf8') } catch (e) { return }  // codex-зеркало опционально
    checked++
    if (RETENTION.test(txt)) violations.push(base(fp) + ': retention -mtime+N-delete')
    txt.split('\n').forEach(function (ln, i) {
      if (DELETE_OP.test(ln) && ARCHIVE_TOKEN.test(ln)) violations.push(base(fp) + ':' + (i + 1) + ' ' + ln.trim().slice(0, 64))
    })
  })
  ok(checked >= 3, 'проверено файлов: ' + checked + ' (≥3 канон)')
  ok(violations.length === 0, 'нет delete/rm на архивном пути' + (violations.length ? ' — НАРУШЕНИЯ:\n    ' + violations.join('\n    ') : ''))
  const wf = fs.readFileSync(files[0], 'utf8')
  ok(/const ARCHIVE = INBOX \+ '\/_archive'/.test(wf), 'ARCHIVE = INBOX + /_archive (durable-локация зафиксирована)')
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
