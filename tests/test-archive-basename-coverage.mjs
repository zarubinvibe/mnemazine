// Регресс на баг archive-гейта: покрытие индексировалось только по `local-media:`/
// `source_hash` (провенанс скриншота), поэтому нота именованного файла (PDF/DOCX)
// с `source: <basename>` гейтом не виделась и архивация никогда не открывалась.
import assert from 'node:assert'
import { sourceBasenames } from '../scripts/mnemazine-archive-covered.mjs'

const has = (text, name) => sourceBasenames(text).has(name)

// скалярная форма — канон для одного именованного файла
assert.ok(has('---\nsource: 2604.03136--StoryScope.pdf\nverified: подтверждён\n---\n\nтело', '2604.03136--StoryScope.pdf'))
// кавычки и путь: сверяется basename, не строка целиком
assert.ok(has('---\nsource: "$HOME/Desktop/Mnemazine Inbox/report.docx"\n---\n', 'report.docx'))
// список — несколько исходников у одной ноты
assert.ok(has('---\nsources:\n  - a.pdf\n  - b.pdf\n---\n', 'b.pdf'))
// inline-массив
assert.ok(has('---\nsources: [a.pdf, b.pdf]\n---\n', 'a.pdf'))
// провенанс скриншота полем source: не притворяется
assert.deepEqual([...sourceBasenames('---\nlocal-media: abc123\n---\n')], [])
// упоминание имени в теле — не провенанс, ложного покрытия быть не должно
assert.deepEqual([...sourceBasenames('---\ntitle: x\n---\n\nсм. файл leak.pdf в архиве\n')], [])
// список закрыт следующим ключом — чужие значения не подхватываются
assert.ok(!has('---\nsources:\n  - a.pdf\ntags:\n  - noise.pdf\n---\n', 'noise.pdf'))

console.log('ok - archive basename coverage: 7/7')
