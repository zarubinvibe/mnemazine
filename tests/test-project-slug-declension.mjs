#!/usr/bin/env node
// Гейт проваливал живые ноты за падеж («для Мнемозины»), а не за отсутствие проекта.
// Проверяем обе стороны: склонения засчитываются, а общие слова — по-прежнему нет.
import assert from 'node:assert/strict'
import { projectSlugs, ruStem, normSpecValue } from '../scripts/mnemazine-note-spec.mjs'

const PROJECTS = `# Проекты
## Юрпрактика «Зарубин и партнеры»
## Фемида
## practice-app
## COFFEECO B2B + «Кофейня» B2C
## Мнемозина
## olympuz
`
const slugs = projectSlugs(PROJECTS)
const mentions = help => slugs.some(s => normSpecValue(help).includes(s))

// падежи имени проекта засчитываются
for (const help of [
  'Для проекта Мнемозина это прямая экономия.',
  'Для Мнемозины это прямая экономия.',
  'Полезно Мнемозине и её конвейеру.',
  'Разбор для Фемиды и её протокола.',
  'В Фемиде тот же приём работает.',
  'Для olympuz — контракт фазы.',
  'Для COFFEECO применимо к отгрузкам.'
]) assert.ok(mentions(help), `не засчитано: ${help}`)

// проза без имени проекта — по-прежнему провал (ради этого гейт и существует)
for (const help of [
  'Это просто полезно всем и всегда.',
  'Партнеры оценят такой подход.',
  'Кофеек станет вкуснее.'
]) assert.ok(!mentions(help), `ложное совпадение: ${help}`)

// стеммер режет одно окончание и не грызёт короткие слова
assert.equal(ruStem('мнемозины'), 'мнемозин')
assert.equal(ruStem('фемиде'), 'фемид')
assert.equal(ruStem('мнемозиной'), 'мнемозин')
assert.equal(ruStem('олимпиады'), 'олимпиад')
// защита от переусердствования: короткое слово остаётся целым, основа не короче пяти букв
assert.equal(ruStem('поле'), 'поле')
assert.equal(ruStem('домами'), 'домам')

console.log('OK: падежи имени проекта засчитываются, общая проза — нет')
