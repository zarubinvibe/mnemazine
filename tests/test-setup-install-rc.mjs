#!/usr/bin/env node
// install.sh объявляет три кода: 0 готов · 2 готов с урезанными возможностями · 1 не доделал.
// setup.sh читал их через `if ! ...` и считал провалом ЛЮБОЙ ненулевой - пользователь видел
// «✓ Готово. Часть возможностей недоступна», а следом «✗ каркас не собран» (issue #6, п.3).
// Проверяем обе стороны на настоящем тексте setup.sh: код 2 продолжает установку, код 1 её рвёт.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const setup = readFileSync(path.join(ROOT, 'setup.sh'), 'utf8')
const start = setup.indexOf('INSTALL_RC=0')
const end = setup.indexOf('\nfi\n', setup.indexOf('elif [ "$INSTALL_RC" -eq 2 ]'))
assert.ok(start > 0 && end > start, 'блок разбора кода install.sh не найден в setup.sh')
const block = setup.slice(start, end + 4)

function runWith(rc) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mnemazine-rc-'))
  writeFileSync(path.join(dir, 'install.sh'), `#!/bin/sh\nexit ${rc}\n`)
  chmodSync(path.join(dir, 'install.sh'), 0o755)
  const script = [
    'set -euo pipefail',
    `ROOT="${dir}"`, 'INBOX="$ROOT/inbox"',
    `. "${path.join(ROOT, 'scripts', 'mnemazine-ui.sh')}"`,
    'run() { "$@"; }',
    block,
    'echo REACHED_END',
  ].join('\n')
  writeFileSync(path.join(dir, 'probe.sh'), script)
  try {
    return { code: 0, out: execFileSync('bash', [path.join(dir, 'probe.sh')], { encoding: 'utf8' }) }
  } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` } }
}

const degraded = runWith(2)
assert.equal(degraded.code, 0, `код 2 обязан продолжать установку, а не рвать её: ${degraded.out}`)
assert.ok(degraded.out.includes('REACHED_END'), 'после кода 2 setup.sh идёт дальше')
assert.ok(/graphify/.test(degraded.out), 'урезанность не объявляется на слово: движки проверяются вызовом')

const broken = runWith(1)
assert.equal(broken.code, 1, `код 1 обязан останавливать установку: ${broken.out}`)
assert.ok(!broken.out.includes('REACHED_END'), 'после кода 1 продолжения нет')

console.log('OK: код 2 - предупреждение с проверкой движков, код 1 - остановка')
