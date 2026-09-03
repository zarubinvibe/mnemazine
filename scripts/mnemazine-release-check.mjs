#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { SPEC_TYPES } from './mnemazine-note-spec.mjs'

import { listTreeFiles } from './mnemazine-tracked-files.mjs'

const ROOT = path.resolve(process.cwd())

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }))
  })
}

function runWithStdin(command, args, input, env = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }))
    child.stdin.write(input)
    child.stdin.end()
  })
}

async function must(label, command, args, options = {}) {
  const result = await run(command, args, options)
  if (result.code !== 0) {
    throw new Error(`${label} failed\n$ ${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`.trim())
  }
  return result
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

async function listFiles(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(file))
    else out.push(file)
  }
  return out
}

function noteType(text) {
  const match = String(text || '').match(/^type:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m)
  return match ? match[1].trim() : ''
}

// Источник правды синтаксиса — git ls-files (CI и локальная машина видят одно и то же),
// пересеченный с наличием на диске. Ручной список из 30 путей (план П11) убран: он не
// проверял десять отслеживаемых .mjs (в т.ч. kb-lint.mjs и normalize-old-frontmatter.mjs —
// оба правят живой vault), ни один .sh и почти все .py.
async function gitLsFiles() {
  // Распакованный релиз не является репозиторием: там правду говорит диск.
  // Подмену отслеживаемого файла это уже не ловит, но в архиве и сравнивать
  // не с чем - именно на этой среде падал изолированный прогон гейта выкладки.
  return listTreeFiles(ROOT).files
}

function syntaxTargetsFrom(tracked) {
  const mjs = tracked.filter(file => /\.mjs$/.test(file) && (file.startsWith('scripts/') || file.startsWith('tests/')))
  const workflows = tracked.filter(file => file === 'workflows/mnemazina-pipeline.js')
  const py = tracked.filter(file => /^scripts\/[^/]+\.py$/.test(file))
  const sh = tracked.filter(file => /\.sh$/.test(file) && file.split('/').length <= 2 && file !== '.mnemazine/config.local.sh')
  return { mjs, workflows, py, sh, all: [...mjs, ...workflows, ...py, ...sh].sort() }
}

async function checkSyntax() {
  const targets = syntaxTargetsFrom(await gitLsFiles())
  // Отсутствие файла из списка git ls-files — провал, а не молчаливый пропуск
  // (тот шов, через который проба «спрячь прибор» проходила зеленой).
  const missing = targets.all.filter(file => !existsSync(path.join(ROOT, file)))
  if (missing.length) throw new Error(`syntax: отслеживаемые файлы отсутствуют на диске: ${missing.join(', ')}`)
  for (const file of targets.mjs) await must(`syntax:${file}`, process.execPath, ['--check', file])
  for (const file of targets.workflows) await must(`workflow-syntax:${file}`, process.execPath, ['scripts/check-workflow-syntax.mjs', file])
  for (const file of targets.py) await must(`syntax:${file}`, 'python3', ['-m', 'py_compile', file])
  for (const file of targets.sh) await must(`syntax:${file}`, 'bash', ['-n', file])
}

async function npmAuditCheck() {
  await must('npm audit', 'npm', ['audit', '--audit-level=moderate'])
}

async function desktopDryRunSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-desktop-dry-'))
  const inbox = path.join(temp, 'live-inbox')
  const vault = path.join(temp, 'live-vault')
  await fs.mkdir(inbox, { recursive: true })
  await fs.mkdir(vault, { recursive: true })
  await fs.writeFile(path.join(inbox, 'live-source.md'), '# Live source\n\nMust stay in live inbox.\n', 'utf8')
  await must('desktop protocol dry-run', 'bash', ['scripts/mnemazine-desktop-protocol.sh', '--dry-run'], {
    env: {
      MNEMAZINE_INBOX: inbox,
      MNEMAZINE_VAULT: vault
    }
  })
  if (!existsSync(path.join(inbox, 'live-source.md'))) throw new Error('desktop dry-run smoke failed: live inbox file changed')
  const vaultFiles = await listFiles(vault)
  if (vaultFiles.length) throw new Error(`desktop dry-run smoke failed: live vault changed (${vaultFiles.join(', ')})`)
}

async function pollRetrySmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-poll-retry-'))
  const bin = path.join(temp, 'bin')
  const state = path.join(temp, 'state')
  await fs.mkdir(bin, { recursive: true })
  await fs.mkdir(state, { recursive: true })
  await fs.mkdir(path.join(temp, '.mnemazine'), { recursive: true })
  await fs.writeFile(path.join(temp, '.mnemazine', 'known_hosts'), 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKpinnedHostKeyForReleaseSmokeOnly1234567890\n', 'utf8')
  await fs.writeFile(path.join(bin, 'ssh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'sync.sh'), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p ${JSON.stringify(state)}
count_file=${JSON.stringify(path.join(state, 'count'))}
count="$(cat "$count_file" 2>/dev/null || echo 0)"
count=$((count + 1))
echo "$count" > "$count_file"
if [ -f ${JSON.stringify(path.join(state, 'fail'))} ]; then exit 1; fi
exit 0
`, { mode: 0o755 })
  await fs.writeFile(path.join(state, 'fail'), '1', 'utf8')
  const env = {
    MNEMAZINE_ROOT: temp,
    MNEMAZINE_VPS: 'deploy@example.test',
    MNEMAZINE_VPS_KEY: path.join(temp, 'missing-key'),
    MNEMAZINE_REMOTE_MUTATION: '1',
    MNEMAZINE_SSH_BIN: path.join(bin, 'ssh'),
    MNEMAZINE_TELEGRAM_SYNC_BIN: path.join(bin, 'sync.sh'),
    MNEMAZINE_POLL_TODAY: '2099-01-01',
    MNEMAZINE_POLL_HOUR: '9',
    MNEMAZINE_DAILY_RETRY_SECONDS: '60',
    MNEMAZINE_DAILY_MAX_ATTEMPTS: '2'
  }
  const first = await run('bash', ['scripts/mnemazine-telegram-poll.sh'], { env: { ...env, MNEMAZINE_POLL_EPOCH: '1000' } })
  if (first.code === 0) throw new Error('poll retry smoke failed: first failing sync passed')
  if (await fs.readFile(path.join(state, 'count'), 'utf8') !== '1\n') throw new Error('poll retry smoke failed: first attempt not counted')
  if (existsSync(path.join(temp, '.mnemazine', '.last-daily-completed'))) throw new Error('poll retry smoke failed: failure marked completed')

  await must('poll retry smoke:no early retry', 'bash', ['scripts/mnemazine-telegram-poll.sh'], { env: { ...env, MNEMAZINE_POLL_EPOCH: '1010' } })
  if (await fs.readFile(path.join(state, 'count'), 'utf8') !== '1\n') throw new Error('poll retry smoke failed: retried before backoff')

  await fs.unlink(path.join(state, 'fail'))
  await must('poll retry smoke:retry success', 'bash', ['scripts/mnemazine-telegram-poll.sh'], { env: { ...env, MNEMAZINE_POLL_EPOCH: '1061' } })
  if (await fs.readFile(path.join(state, 'count'), 'utf8') !== '2\n') throw new Error('poll retry smoke failed: retry did not run')
  const completed = await fs.readFile(path.join(temp, '.mnemazine', '.last-daily-completed'), 'utf8')
  if (completed.trim() !== '2099-01-01') throw new Error('poll retry smoke failed: success not marked completed')

  await must('poll retry smoke:no rerun after complete', 'bash', ['scripts/mnemazine-telegram-poll.sh'], { env: { ...env, MNEMAZINE_POLL_EPOCH: '2000' } })
  if (await fs.readFile(path.join(state, 'count'), 'utf8') !== '2\n') throw new Error('poll retry smoke failed: completed daily reran')
}

async function demoSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-release-'))
  const inbox = path.join(temp, 'inbox')
  const vault = path.join(temp, 'vault')
  const scripts = path.join(temp, 'scripts')
  const config = path.join(temp, 'config')
  await fs.mkdir(inbox, { recursive: true })
  await fs.mkdir(vault, { recursive: true })
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(config, { recursive: true })
  await fs.copyFile(path.join(ROOT, 'demo/inbox/example-guide.md'), path.join(inbox, 'example-guide.md'))
  await fs.writeFile(path.join(inbox, 'empty-source.bin'), '')
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-paths.mjs'), path.join(scripts, 'mnemazine-paths.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-note-spec.mjs'), path.join(scripts, 'mnemazine-note-spec.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-vault-quality-gate.mjs'), path.join(scripts, 'mnemazine-vault-quality-gate.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-synthesize.mjs'), path.join(scripts, 'mnemazine-synthesize.mjs'))
  // synthesize импортирует metiz: без него песочница падает ERR_MODULE_NOT_FOUND ещё до первой проверки.
  // Список копирования ручной, и врезка Метиды его не пополнила - гейт краснел на исправном коде.
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-metiz.mjs'), path.join(scripts, 'mnemazine-metiz.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-llm.mjs'), path.join(scripts, 'mnemazine-llm.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-cli-router.mjs'), path.join(scripts, 'mnemazine-cli-router.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-cli-probe.mjs'), path.join(scripts, 'mnemazine-cli-probe.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-codex.mjs'), path.join(scripts, 'mnemazine-codex.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-verify.mjs'), path.join(scripts, 'mnemazine-verify.mjs'))
  await fs.copyFile(path.join(ROOT, 'config/cli-registry.json'), path.join(config, 'cli-registry.json'))
  await fs.writeFile(path.join(config, 'cli-registry.local.json'), '{}\n', 'utf8')

  await must('demo intake smoke', process.execPath, ['scripts/mnemazine-run.mjs'], {
    env: {
      MNEMAZINE_ROOT: temp,
      MNEMAZINE_INBOX: inbox,
      MNEMAZINE_VAULT: vault,
      // finishRun не входит в контракт этого смоука (он про intake→synth→archive),
      // а его обязательные скрипты сюда не копируются — runLocalNodeScript теперь
      // fail-closed на пропаже обязательного. Гасим finish, как уже делает
      // strictArchiveGateSmoke ниже.
      MNEMAZINE_FINISH: '0'
    }
  })

  const inboxFiles = await fs.readdir(inbox)
  if (inboxFiles.length !== 1 || inboxFiles[0] !== 'empty-source.bin') {
    throw new Error(`demo smoke failed: expected only unextractable source in inbox (${inboxFiles.join(', ')})`)
  }

  const notes = (await listFiles(vault))
    .filter(file => file.endsWith('.md'))
    .filter(file => !file.split(path.sep).includes('graphify-out'))
  if (notes.length < 1) throw new Error(`demo smoke failed: expected synthesized notes, got ${notes.length}`)
  const forbidden = [/intake-draft/i, /draft-local/i, /\btemp_image/i, /\bIMG_\d+/, /\.(WEBP|PNG|JPE?G|HEIC|TIFF)\b/, /status:\s*"candidate"/i, /local extraction only/i]
  for (const noteFile of notes) {
    const note = await fs.readFile(noteFile, 'utf8')
    const hit = forbidden.find(re => re.test(note))
    if (hit) throw new Error(`demo smoke failed: raw marker in ${path.basename(noteFile)} (${hit})`)
    const type = noteType(note)
    if (!SPEC_TYPES.has(type)) throw new Error(`demo smoke failed: ${path.basename(noteFile)} type is outside NOTE-SPEC enum: ${type || 'empty'}`)
    if (!/source_ref:\s*"session:/.test(note) || !/local-media:/.test(note)) throw new Error(`demo smoke failed: ${path.basename(noteFile)} synthesis provenance missing`)
  }

  const archived = await listFiles(path.join(temp, '.mnemazine/archive'))
  if (archived.length !== 1) throw new Error(`demo smoke failed: expected 1 archived finalized source, got ${archived.length}`)

  const extractRecords = (await listFiles(path.join(temp, '.mnemazine/cache/extracted'))).filter(file => file.endsWith('.json'))
  if (extractRecords.length !== 2) throw new Error(`demo smoke failed: expected 2 extract records, got ${extractRecords.length}`)
  const cache = await readJson(path.join(temp, '.mnemazine/cache/processed-hashes.json'))
  const cacheOnly = Object.values(cache).filter(value => value && typeof value === 'object' && value.status === 'needs_manual_context')
  if (cacheOnly.length !== 1) throw new Error(`demo smoke failed: expected 1 cache-only source, got ${cacheOnly.length}`)

  await fs.copyFile(path.join(ROOT, 'demo/inbox/example-guide.md'), path.join(inbox, 'cached-guide.md'))
  await must('demo cached-source archive smoke', process.execPath, ['scripts/mnemazine-run.mjs'], {
    env: {
      MNEMAZINE_ROOT: temp,
      MNEMAZINE_INBOX: inbox,
      MNEMAZINE_VAULT: vault,
      MNEMAZINE_FINISH: '0'
    }
  })
  const cachedInboxFiles = await fs.readdir(inbox)
  if (cachedInboxFiles.length !== 1 || cachedInboxFiles[0] !== 'empty-source.bin') {
    throw new Error(`demo cached smoke failed: expected only unextractable source in inbox (${cachedInboxFiles.join(', ')})`)
  }
  const archivedAfterCachedRun = await listFiles(path.join(temp, '.mnemazine/archive'))
  if (archivedAfterCachedRun.length !== 2) throw new Error(`demo cached smoke failed: expected 2 archived finalized sources, got ${archivedAfterCachedRun.length}`)
}

async function strictArchiveGateSmoke() {
  async function writeCachedCase(temp, noteBody) {
    const inbox = path.join(temp, 'inbox')
    const vault = path.join(temp, 'vault')
    const scripts = path.join(temp, 'scripts')
    const config = path.join(temp, 'config')
    const extracts = path.join(temp, '.mnemazine/cache/extracted')
    await fs.mkdir(inbox, { recursive: true })
    await fs.mkdir(path.join(vault, '01 Concepts'), { recursive: true })
    await fs.mkdir(scripts, { recursive: true })
    await fs.mkdir(config, { recursive: true })
    await fs.mkdir(extracts, { recursive: true })
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-paths.mjs'), path.join(scripts, 'mnemazine-paths.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-note-spec.mjs'), path.join(scripts, 'mnemazine-note-spec.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-vault-quality-gate.mjs'), path.join(scripts, 'mnemazine-vault-quality-gate.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-digest.mjs'), path.join(scripts, 'mnemazine-digest.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-humanize-gate.mjs'), path.join(scripts, 'mnemazine-humanize-gate.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-human-layer-gate.mjs'), path.join(scripts, 'mnemazine-human-layer-gate.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-llm.mjs'), path.join(scripts, 'mnemazine-llm.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-cli-router.mjs'), path.join(scripts, 'mnemazine-cli-router.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-cli-probe.mjs'), path.join(scripts, 'mnemazine-cli-probe.mjs'))
    await fs.copyFile(path.join(ROOT, 'scripts/mnemazine-codex.mjs'), path.join(scripts, 'mnemazine-codex.mjs'))
    await fs.copyFile(path.join(ROOT, 'config/cli-registry.json'), path.join(config, 'cli-registry.json'))
    await fs.writeFile(path.join(config, 'cli-registry.local.json'), '{}\n', 'utf8')

    const source = 'MarkItDown converts Office/PDF/image inputs into Markdown for LLM pipelines. This cached source has enough text for synthesis.'
    const hash = sha256Text(source)
    const ref = `local-media:${hash.slice(0, 16)}`
    await fs.writeFile(path.join(inbox, 'source.md'), source, 'utf8')
    await fs.writeFile(path.join(extracts, `${hash}.txt`), source, 'utf8')
    await fs.writeFile(path.join(extracts, `${hash}.json`), JSON.stringify({ source_ref: ref, status: 'extracted_for_note', text_path: `${hash}.txt` }, null, 2), 'utf8')
    await fs.mkdir(path.join(temp, '.mnemazine/cache'), { recursive: true })
    await fs.writeFile(path.join(temp, '.mnemazine/cache/processed-hashes.json'), JSON.stringify({
      [hash]: { status: 'extracted_for_note', source_ref: ref, cache: `.mnemazine/cache/extracted/${hash}.json` }
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(vault, '01 Concepts', 'cached-note.md'), noteBody(ref), 'utf8')
    return { inbox, vault, sourceFile: path.join(inbox, 'source.md') }
  }

  const weakTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-strict-weak-'))
  const weak = await writeCachedCase(weakTemp, ref => `---
title: "Weak cached note"
type: "concept"
verified: false
verification_status: "unknown"
status: "draft"
enrichment: "missing"
---

# Weak cached note

## What This Is

Cached OCR-like material, not final knowledge.

## Source

Local source refs:
- ${ref}

Public/source expansion:
- No public source detected.
`)
  const weakRun = await run(process.execPath, ['scripts/mnemazine-run.mjs'], {
    env: {
      MNEMAZINE_ROOT: weakTemp,
      MNEMAZINE_INBOX: weak.inbox,
      MNEMAZINE_VAULT: weak.vault,
      MNEMAZINE_DEEP: '1',
      MNEMAZINE_REQUIRE_DEEP: '1',
      MNEMAZINE_SYNTHESIZE: '0',
      MNEMAZINE_FINISH: '0'
    }
  })
  if (weakRun.code === 0) throw new Error('strict archive gate smoke failed: weak cached note passed')
  if (!existsSync(weak.sourceFile)) throw new Error('strict archive gate smoke failed: weak cached source was archived')

  const goodTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-strict-good-'))
  const good = await writeCachedCase(goodTemp, ref => `---
title: "Verified enriched cached note"
type: "concept"
verified: true
verification_status: "verified"
status: "final"
enrichment: "external-research"
---

# Проверенная cached note

## Что это

MarkItDown здесь зафиксирован как проверенное переиспользуемое знание, а не голый распознанный текст.

## Как использовать

- Держать source refs как доказательство происхождения.
- Проверять публичный репозиторий перед рекомендацией.
- Архивировать исходник только после verified final note.

## Источники

Local source refs:
- ${ref}

Публичные источники:
- Microsoft MarkItDown: https://github.com/microsoft/markitdown

## Расширение знания

Факты, добавленные до атомизации:
- Microsoft maintains MarkItDown as an open-source file-to-Markdown converter.
- The public repository documents optional extras for additional input formats.

## Проверка

- Статус: verified.
- Источник сверяется с публичным GitHub URL.

## Следующее действие

- Держать эту ноту как smoke fixture для strict archive gate.
`)
  await must('strict archive gate smoke:good', process.execPath, ['scripts/mnemazine-run.mjs'], {
    env: {
      MNEMAZINE_ROOT: goodTemp,
      MNEMAZINE_INBOX: good.inbox,
      MNEMAZINE_VAULT: good.vault,
      MNEMAZINE_DEEP: '1',
      MNEMAZINE_REQUIRE_DEEP: '1',
      MNEMAZINE_SYNTHESIZE: '0',
      MNEMAZINE_FINISH: '0'
    }
  })
  if (existsSync(good.sourceFile)) throw new Error('strict archive gate smoke failed: verified cached source stayed in inbox')
}

async function qualityAndPublicChecks() {
  await must('verify selftest', process.execPath, ['scripts/mnemazine-verify.mjs', '--selftest'])
  await must('webapp selftest', process.execPath, ['scripts/mnemazine-webapp-server.mjs', '--selftest'])
  await must('telegram bot selftest', process.execPath, ['scripts/mnemazine-telegram-bot.mjs', '--selftest'])
  await must('weekly state selftest', process.execPath, ['scripts/mnemazine-weekly-state.mjs', '--selftest'])
  await must('live status selftest', process.execPath, ['scripts/mnemazine-live-status.mjs', '--selftest'])
  await must('doctor selftest', process.execPath, ['scripts/mnemazine-doctor.mjs', '--selftest'])
  await must('semantic graph task selftest', process.execPath, ['scripts/mnemazine-semantic-graph-task.mjs', '--selftest'])
  // Явный корпус, а не дефолтный vault/: он не публикуется, а установщик в песочнице
  // гейта идет сухим и каталога не создает. Смоук не должен требовать живой корпус.
  await must('semantic monitor dry-run smoke', process.execPath, ['scripts/mnemazine-semantic-graph-task.mjs', '--monitor', '--dry-run', '--stale-hours', '1', '--vault', 'demo/vault'])
  await semanticShardResumeSmoke()
  await must('agent-os mirror selftest', process.execPath, ['scripts/mnemazine-athena-mirror.mjs', '--selftest'])
  await must('agent-os mirror manifest check', process.execPath, ['scripts/mnemazine-athena-mirror.mjs', '--check', '--repo-only'])
  await must('wiki link cleanup selftest', process.execPath, ['scripts/mnemazine-wiki-link-cleanup.mjs', '--selftest'])
  await must('demo vault quality', 'npm', ['run', 'quality', '--', '--vault', 'demo/vault'])
  await vaultFinalAuditSmoke()
  await toolDecisionQueueSmoke()
  await reportQualityGateSmoke()
  await digestAliasSmoke()
  await humanLayerGateSmoke()
  await completeGateSmoke()
}

async function semanticShardResumeSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-semantic-resume-'))
  const vault = path.join(temp, 'vault')
  const shards = path.join(temp, 'shards')
  const graph = path.join(vault, 'graphify-out', 'graph.json')
  await fs.mkdir(path.join(vault, 'graphify-out'), { recursive: true })
  await fs.mkdir(shards, { recursive: true })
  await fs.writeFile(path.join(vault, 'note.md'), '# Resume smoke\n\nCached shard should skip worker.\n', 'utf8')
  await fs.writeFile(graph, '{"nodes":[],"links":[]}\n', 'utf8')
  const shardGraph = path.join(shards, '00000-00000.json')
  const signature = JSON.stringify({
    start: 0,
    limit: 1,
    batchSize: 1,
    excerptChars: 600,
    maxTokens: 360,
    backend: 'resume-smoke',
    model: 'resume-smoke',
    cache: true
  })
  await fs.writeFile(shardGraph, '{"nodes":[],"links":[]}\n', 'utf8')
  await fs.writeFile(path.join(shards, 'manifest.json'), '{}\n', 'utf8')
  await fs.writeFile(path.join(shards, '00000-00000.done.json'), `${JSON.stringify({ signature, graph: shardGraph }, null, 2)}\n`, 'utf8')
  const result = await must('semantic shard resume smoke', process.execPath, [
    'scripts/mnemazine-semantic-swarm.mjs',
    '--vault', vault,
    '--graph', graph,
    '--shards-dir', shards,
    '--limit', '1',
    '--chunk-size', '1',
    '--batch-size', '1',
    '--backend', 'resume-smoke',
    '--model', 'resume-smoke',
    '--concurrency', '1'
  ])
  const parsed = JSON.parse(result.stdout)
  if (parsed.skipped !== 1 || !parsed.resumed) throw new Error('semantic shard resume smoke failed: completed shard was not resumed')
  const progress = await readJson(path.join(shards, 'progress.json'))
  if (progress.remaining_jobs !== 0 || progress.skipped_completed_jobs !== 1) throw new Error('semantic shard resume smoke failed: progress counters wrong')
}

async function vaultFinalAuditSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-vault-final-audit-'))
  const vault = path.join(temp, 'vault')
  const concepts = path.join(vault, '01 Concepts')
  const system = path.join(vault, '99 Система')
  await fs.mkdir(concepts, { recursive: true })
  await fs.mkdir(system, { recursive: true })
  await fs.mkdir(path.join(vault, 'graphify-out'), { recursive: true })
  await fs.writeFile(path.join(vault, 'graphify-out', 'graph.json'), '{}\n', 'utf8')
  await fs.writeFile(path.join(concepts, 'good.md'), `---
title: "Проверенная заметка"
type: "concept"
aliases: ["Рабочая заметка"]
---

# Проверенная заметка

## Что это

Русская финальная заметка без raw-маркеров и приватных имен файлов.

## Как использовать

Использовать как smoke fixture для full-vault audit.

## Источники

- local-media:vaultfinalaudit

## Проверка

Статус: assumed.

## Следующее действие

Оставить final-audit в release-check.
`, 'utf8')
  await fs.writeFile(path.join(system, 'Протокол_Мнемозина.md'), `# Протокол

## Что это

Системная smoke-заметка со ссылкой на [[Рабочая заметка]].
`, 'utf8')

  await must('vault final audit smoke:good', process.execPath, ['scripts/mnemazine-vault-final-audit.mjs', '--vault', vault])

  await fs.mkdir(path.join(concepts, 'skills', 'graphify-out'), { recursive: true })
  await fs.writeFile(path.join(concepts, 'private path leaked temp_image.md'), '# Bad\n\n## What This Is\n\nIMG_1234.PNG raw OCR\n', 'utf8')
  const bad = await run(process.execPath, ['scripts/mnemazine-vault-final-audit.mjs', '--vault', vault])
  if (bad.code === 0) throw new Error('vault final audit smoke failed: bad vault passed')
}

async function digestAliasSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-digest-alias-'))
  const vault = path.join(temp, 'vault')
  const concepts = path.join(vault, '01 Concepts')
  await fs.mkdir(concepts, { recursive: true })
  const started = new Date(Date.now() - 1000).toISOString()
  await fs.writeFile(path.join(concepts, 'source-a.md'), `---
title: "Looper: проектирование цикла агента"
type: "concept"
cluster_id: "alias-smoke"
---

# Looper: проектирование цикла агента

## Что это

Заметка объясняет, зачем сначала описывать цель, проверки и лимиты цикла, а уже потом запускать агента.

## Зачем это нужно

Так меньше риск сжечь токены на плохо поставленную задачу.

## Как использовать

- Сначала собрать короткий loop.yaml.
- Потом отдать цикл исполнителю.

## Источники

- https://github.com/ksimback/looper

## Проверка

Источник требует отдельной проверки перед установкой.

## Следующее действие

- Проверить навык и поставить только после scan.
`, 'utf8')
  await fs.writeFile(path.join(concepts, 'source-b.md'), `---
title: "Проверки цикла агента"
type: "concept"
cluster_id: "alias-smoke"
---

# Проверки цикла агента

## Что это

Заметка фиксирует роль reviewer, команды проверки и стоп-условий для агентного цикла.

## Зачем это нужно

Проверки делают цикл наблюдаемым и не дают ему крутиться без прогресса.

## Как использовать

- Задать критерий готовности.
- Задать лимит итераций.

## Источники

- local-media:alias-smoke

## Проверка

Локальная smoke-заметка для release-check.

## Следующее действие

- Проверить формат ссылок в digest.
`, 'utf8')

  await must('digest alias smoke:run', process.execPath, ['scripts/mnemazine-digest.mjs', '--vault', vault, '--session', 'alias-smoke', '--deterministic', '--changed-since', started])
  const digest = await fs.readFile(path.join(vault, '_digest', 'Сводка-alias-smoke.md'), 'utf8')
  if (/\[\[[^\]|]+\]\]/.test(digest)) throw new Error('digest alias smoke failed: bare wikilink found')
  if (!digest.includes('[[01 Concepts/source-a|Looper: проектирование цикла агента]]')) throw new Error('digest alias smoke failed: note alias missing')
  if (!digest.includes('[[01 Concepts/source-b|Проверки цикла агента]]')) throw new Error('digest alias smoke failed: connection alias missing')
}

async function toolDecisionQueueSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-tool-queue-'))
  const vault = path.join(temp, 'vault')
  const concepts = path.join(vault, '01 Concepts')
  await fs.mkdir(concepts, { recursive: true })
  const started = new Date(Date.now() - 1000).toISOString()
  await fs.writeFile(path.join(concepts, 'aider.md'), `---
title: "Aider-AI/aider: решение для Mnemazine"
type: "concept"
verified: true
verification_status: "verified"
status: "final"
---

# Aider-AI/aider: решение для Mnemazine

## Что это

CLI-инструмент для разработки с LLM внутри локального git-репозитория.

## Решение

Хранить как кандидата в рабочие возможности, не устанавливать автоматически.

## Что добавила Mnemazine

- Метаданные GitHub: 1 звезда, 1 форк, 1 issue, MIT, основной язык Python.
- Свежесть репозитория: основная ветка main, последний push 2026-06-24, последний release v1.

## Источники

- https://github.com/Aider-AI/aider

## Проверка

- Статус: verified.

## Следующее действие

- Добавить в очередь разбора возможностей.
`, 'utf8')
  await must('tool decision queue smoke', process.execPath, ['scripts/mnemazine-tool-decision-queue.mjs', '--vault', vault, '--changed-since', started])
  const out = path.join(vault, '08 AI и Инструменты/Tools/Очередь разбора инструментов.md')
  const body = await fs.readFile(out, 'utf8')
  for (const token of ['# Очередь разбора инструментов', 'Aider', 'Пробный запуск', 'берем, откладываем, забываем']) {
    if (!body.includes(token)) throw new Error(`tool queue smoke failed: missing ${token}`)
  }
}

async function completeGateSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-complete-gate-'))
  const inbox = path.join(temp, 'inbox')
  const reports = path.join(temp, 'reports')
  const state = path.join(temp, 'state')
  await fs.mkdir(inbox, { recursive: true })
  await fs.mkdir(reports, { recursive: true })
  await fs.mkdir(state, { recursive: true })
  await fs.writeFile(path.join(reports, 'complete-smoke.html'), [
    '<!doctype html><html><body>',
    '<main data-knowledge-atom="complete-smoke">',
    '<h1>Отчет Mnemazine после прогона</h1>',
    '<section><h2>Новые и обновленные знания</h2><p>Свежий слой знаний на русском языке: понятно, что обработано, что проверено и какой следующий шаг нужен человеку.</p></section>',
    '<section><h2>Синтез</h2><p>Проверенная идея после обработки превращена в короткий вывод, а не оставлена как сырой захват.</p></section>',
    '<section><h2>Источники</h2>',
    '<a href="https://example.com/source-a">source a</a>',
    '<a href="https://example.com/source-b">source b</a>',
    '<a href="https://example.com/source-c">source c</a></section>',
    '<section><h2>Где применить</h2><p>В пайплайне.</p></section>',
    '<section><h2>Проверка и риск</h2><p>Проверить источники.</p></section>',
    '<section><h2>Следующее действие</h2><p>Запустить gate.</p></section>',
    '</main></body></html>'
  ].join(''), 'utf8')
  await fs.writeFile(path.join(state, 'last-action-brief.md'), [
    '# Короткий отчет Mnemazine — smoke',
    '',
    '## Статус',
    '',
    '- Inbox: 0',
    '- Гейт качества: ok',
    '',
    '## Следующие действия',
    '',
    '- Держать release gate зеленым.'
  ].join('\n'), 'utf8')
  await fs.writeFile(path.join(state, 'last-run.json'), JSON.stringify({
    ok: true,
    started_at: new Date().toISOString(),
    deep: false,
    processed: 0,
    synthesize: { skipped: true }
  }, null, 2), 'utf8')
  // Потолок спеки для демо-корпуса (план П06 шаг 8): единственная демо-нота спеке
  // не отвечает, потолок честно равен 1 — spec-ceiling --check из complete-check
  // держится, а не краснеет. Пишется во временный MNEMAZINE_STATE, не в репозиторий.
  await fs.writeFile(path.join(state, 'spec-ceiling.json'), JSON.stringify({
    vault: path.join(ROOT, 'demo/vault'),
    ceiling: 1
  }, null, 2), 'utf8')
  await must('complete gate smoke', process.execPath, ['scripts/mnemazine-complete-check.mjs'], {
    env: {
      MNEMAZINE_VAULT: path.join(ROOT, 'demo/vault'),
      MNEMAZINE_INBOX: inbox,
      MNEMAZINE_REPORTS: reports,
      MNEMAZINE_STATE: state
    }
  })
}

async function reportQualityGateSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-report-gate-'))
  const raw = path.join(temp, 'raw.html')
  const good = path.join(temp, 'good.html')
  await fs.writeFile(raw, [
    '<!doctype html><html><body>',
    '<article><h2>Video keyframe OCR</h2><p>IMG_1234.PNG raw OCR без синтеза.</p></article>',
    '</body></html>'
  ].join(''), 'utf8')
  await fs.writeFile(good, [
    '<!doctype html><html><body>',
    '<main data-knowledge-atom="demo">',
    '<h1>Синтезированные знания</h1>',
    '<section><h2>Синтез</h2><p>Проверенная идея после обработки.</p></section>',
    '<section><h2>Расширил источниками</h2>',
    '<a href="https://example.com/a">a</a>',
    '<a href="https://example.com/b">b</a>',
    '<a href="https://example.com/c">c</a></section>',
    '<section><h2>Где применить</h2><p>В пайплайне.</p></section>',
    '<section><h2>Проверка и риск</h2><p>Проверить источники.</p></section>',
    '<section><h2>Следующее действие</h2><p>Добавить тест.</p></section>',
    '</main></body></html>'
  ].join(''), 'utf8')

  const rawResult = await run(process.execPath, ['scripts/mnemazine-report-quality-gate.mjs', '--report', raw])
  if (rawResult.code === 0) throw new Error('report gate smoke failed: raw OCR report passed')

  await must('report quality gate smoke:good', process.execPath, ['scripts/mnemazine-report-quality-gate.mjs', '--report', good])
}

async function humanLayerGateSmoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-human-layer-'))
  const vault = path.join(temp, 'vault')
  const reports = path.join(temp, 'reports')
  const state = path.join(temp, 'state')
  const concepts = path.join(vault, '01 Concepts')
  const digest = path.join(vault, '_digest')
  await fs.mkdir(concepts, { recursive: true })
  await fs.mkdir(digest, { recursive: true })
  await fs.mkdir(reports, { recursive: true })
  await fs.mkdir(state, { recursive: true })
  const started = new Date(Date.now() - 1000).toISOString()
  await fs.writeFile(path.join(concepts, 'good.md'), `---
title: "Хорошая русская заметка"
type: "concept"
status: "final"
verified: true
verification_status: "verified"
---

# Хорошая русская заметка

## Что это

Это проверенное знание: оно объясняет смысл, применение, источник и следующий шаг обычным русским языком.

## Как использовать

- Читать вывод, а не сырой захват.
- Проверять источник перед применением.
- Превращать вывод в маленькое действие.

## Источники

- local-media:humanlayersmoke
- https://example.com/source

## Проверка

- Статус: verified.
- Сырой HTML исключен из финального слоя.

## Следующее действие

- Оставить human-layer gate в release-check.
`, 'utf8')
  await fs.writeFile(path.join(concepts, 'github-atom.md'), `---
title: "tech-leads-club/agent-skills: что реально обещает README"
type: "concept"
status: "final"
verified: true
verification_status: "verified"
---

# tech-leads-club/agent-skills: что реально обещает README

## Что это

README позиционирует tech-leads-club/agent-skills как проверенный каталог skills для AI coding agents. Рабочий смысл простой: это кандидат на разбор, а не команда сразу ставить глобально.

## Зачем это нужно

Скриншот со stars еще не знание. Нужны первоисточник, свежесть репозитория, лицензия, открытые issues и понятный риск доверия.

## Как использовать

- Проверить заявленную валидацию skills.
- Отдельно посмотреть security-claim про уязвимости marketplace skills.
- Связать каталог с одним нашим workflow до установки.

## Источники

Локальные source refs:
- local-media:humanlayergithub

Публичные источники:
- github.com: https://github.com/tech-leads-club/agent-skills

## Расширение знания

Факты, добавленные до атомизации:
- GitHub README описывает проект как проверенный каталог skills для coding agents.
- Метаданные GitHub добавляют проверяемые признаки свежести и поддержки.

## Проверка

- Статус проверки: verified.

## Следующее действие

- Добавить репозиторий в очередь разбора возможностей с одним критерием: принять или отклонить.
`, 'utf8')
  await fs.writeFile(path.join(digest, 'Сводка-smoke.md'), `---
title: "Сводка знаний — smoke"
type: "knowledge-digest"
source_ref: "digest:smoke"
---

# Сводка знаний — smoke

## Что это

Сводка связывает новые заметки после прогона и показывает, какие выводы уже можно открыть как карту знаний.

## Зачем это нужно

Она нужна как быстрый слой повторного использования: видно, какие заметки появились, что они дают и где лежат связи.

## Как использовать

- Открыть связанные заметки из списка ниже.
- Взять сильные следующие действия в работу.
- Проверить слабые связи перед публикацией.

## Источник

- source_ref: digest:smoke
- processed_notes: 2

## Проверка

Сводка построена локально из заметок vault. Это не внешняя факт-проверка, а навигационная карта после прогона.

## Связанные заметки

- [[Mnemazine Protocol]]

## Повторное использование

Обработано заметок: 2. Ниже — что узнано и как связано.

## Проверенная карточка инструмента

- Заметка: [[01 Concepts/synthesis-tech-leads-club-agent-skills-readme-backed-capability-summary-fd502aea4d]]
- Связи: [[01 Concepts/synthesis-affaan-m-ecc-mnemazine-routing-decision-1c84a44c58]], [[01 Concepts/synthesis-browser-use-browser-use-operational-risk-and-maintenance-check-ebe5f6e21e]], [[01 Concepts/synthesis-ksimback-looper-verified-tool-identity-and-adoption-signal-3d2bc03aaf]], [[01 Concepts/synthesis-tech-leads-club-agent-skills-operational-risk-and-maintenance-check-cdedd86d2b]], [[01 Concepts/synthesis-browser-use-browser-use-readme-backed-capability-summary-fd502aea4d]], [[01 Concepts/synthesis-affaan-m-ecc-verified-tool-identity-and-adoption-signal-3d2bc03aaf]], [[01 Concepts/synthesis-really-long-agent-workflow-loop-design-before-runtime-with-reviewer-model-judge-token-budget-no-progress-limit-and-session-state-files-readme-backed-capability-summary-aabbccddeeff00112233445566778899]], [[01 Concepts/synthesis-really-long-agent-workflow-loop-design-before-runtime-with-reviewer-model-judge-token-budget-no-progress-limit-and-session-state-files-operational-risk-and-maintenance-check-aabbccddeeff00112233445566778899]], [[01 Concepts/synthesis-really-long-agent-workflow-loop-design-before-runtime-with-reviewer-model-judge-token-budget-no-progress-limit-and-session-state-files-verified-tool-identity-and-adoption-signal-aabbccddeeff00112233445566778899]], [[01 Concepts/synthesis-really-long-agent-workflow-loop-design-before-runtime-with-reviewer-model-judge-token-budget-no-progress-limit-and-session-state-files-mnemazine-routing-decision-aabbccddeeff00112233445566778899]]
`, 'utf8')
  const report = path.join(reports, 'good.html')
  await fs.writeFile(report, [
    '<!doctype html><html><body>',
    '<h1>Отчет Mnemazine после прогона</h1>',
    '<section><h2>Новые и обновленные знания</h2><p>Понятная сводка объясняет, что появилось, зачем это нужно, где источник и какое действие взять следующим шагом.</p></section>',
    '<section><h2>Проверка и риск</h2><p>Сырой HTML исключен из пользовательского текста, а непроверенные утверждения остаются помеченными до ручной проверки.</p></section>',
    '<section><h2>Следующее действие</h2><p>Запустить gate и убедиться, что отчет читается человеком без знания внутреннего пайплайна.</p></section>',
    '</body></html>'
  ].join(''), 'utf8')
  await fs.writeFile(path.join(state, 'last-action-brief.md'), [
    '# Короткий отчет Mnemazine — smoke',
    '',
    '## Статус',
    '',
    '- Inbox: 0',
    '',
    '## Следующие действия',
    '',
    '- Проверить human-layer gate.'
  ].join('\n'), 'utf8')
  await must('human layer gate smoke:good', process.execPath, ['scripts/mnemazine-human-layer-gate.mjs', '--changed-since', started, '--report', report], {
    env: {
      MNEMAZINE_VAULT: vault,
      MNEMAZINE_REPORTS: reports,
      MNEMAZINE_STATE: state
    }
  })

  await fs.writeFile(path.join(concepts, 'bad.md'), `# Bad note

## What This Is

README signal: src="https://example.com/badge.svg"
`, 'utf8')
  const bad = await run(process.execPath, ['scripts/mnemazine-human-layer-gate.mjs', '--changed-since', started, '--report', report], {
    env: {
      MNEMAZINE_VAULT: vault,
      MNEMAZINE_REPORTS: reports,
      MNEMAZINE_STATE: state
    }
  })
  if (bad.code === 0) throw new Error('human layer gate smoke failed: bad note passed')
}

async function searchEvalSmoke() {
  // Tier A only (0 tokens): recall/anti-noise of the KB search skill. Tier B
  // (LLM judge) is opt-in via `npm run search:eval -- --deep`, not in the gate.
  await must('kb-search selftest', process.execPath, ['scripts/mnemazine-kb-search.mjs', '--selftest'])
  await must('kb-search eval (Tier A)', process.execPath, ['tests/search-eval.mjs'])
}

async function repoMetadataCheck() {
  const pkg = await readJson(path.join(ROOT, 'package.json'))
  if (!pkg.description || !/[А-Яа-яЁё]/.test(pkg.description) || !/[A-Za-z]/.test(pkg.description)) {
    throw new Error('package description must be bilingual')
  }

  // Bilingual READMEs as two files: README.md (English entry) + README.ru.md (Russian).
  const en = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8')
  const ru = await fs.readFile(path.join(ROOT, 'README.ru.md'), 'utf8').catch(() => null)
  if (ru === null) throw new Error('README.ru.md is missing (Russian README required)')

  // Каноническое имя публичного репозитория — в нижнем регистре: `git remote`
  // (public) и full_name в GitHub API дают zarubinvibe/mnemazine. Старое ожидание
  // с большой буквы сторожило исчезнувшее имя. Гарантия прежняя: оба README несут
  // рабочую строку клонирования настоящего репозитория.
  const CLONE_URL = 'https://github.com/zarubinvibe/mnemazine.git'
  for (const [label, body] of [['README.md', en], ['README.ru.md', ru]]) {
    if (!body.includes(CLONE_URL)) {
      throw new Error(`${label} clone URL is stale or missing (ждем ${CLONE_URL})`)
    }
  }

  // Each version links to the other so readers can switch languages.
  if (!en.includes('README.ru.md')) throw new Error('README.md must link to README.ru.md')
  if (!ru.includes('README.md')) throw new Error('README.ru.md must link back to README.md')

  // Language sanity: English entry stays English-primary, Russian entry carries Cyrillic.
  if (!/[A-Za-z]/.test(en)) throw new Error('README.md must contain English text')
  if (!/[А-Яа-яЁё]/.test(ru)) throw new Error('README.ru.md must contain Russian text')

  // Section parity (drift guard): both versions must expose the same H2 sections.
  const h2 = body => (body.match(/^##\s+/gm) || []).length
  if (h2(en) !== h2(ru)) {
    throw new Error(`README section parity mismatch: README.md has ${h2(en)} H2, README.ru.md has ${h2(ru)}`)
  }
}

// Пять мета-приборов П11: каждый — отдельный скрипт с честным кодом возврата и --selftest.
async function runMetaGate(scriptRel) {
  await must(scriptRel, process.execPath, [scriptRel])
}
async function rulesInventoryGate() { await runMetaGate('scripts/mnemazine-rules-inventory.mjs') }
async function docContractGate() { await runMetaGate('scripts/mnemazine-doc-contract-check.mjs') }
async function singleTruthGate() { await runMetaGate('scripts/mnemazine-single-truth-check.mjs') }
async function lessonGateCheck() { await runMetaGate('scripts/mnemazine-lesson-gate.mjs') }
async function checksInventoryGate() { await runMetaGate('scripts/mnemazine-checks-inventory.mjs') }
async function modelPinCheck() { await runMetaGate('scripts/mnemazine-model-pin-check.mjs') }

async function trackingGuardCheck() { await runMetaGate('scripts/mnemazine-tracking-guard.mjs') }

const NEW_CHECKS = new Set(['rules-inventory', 'doc-contract-check', 'single-truth-check', 'lesson-gate', 'checks-inventory'])

// П24: every rsync/scp whose DESTINATION is the VPS in scripts/*.sh must be
// preceded, in the same file, by a machine-class-gate call. A dangling outbound
// transfer (gate cut out, rsync left) is a hole — hostile probe 5 breaks exactly
// this. Also runs the gate's hermetic --selftest so a broken taxonomy reddens here.
async function machineClassGateCheck() {
  const gate = path.join(ROOT, 'scripts', 'mnemazine-machine-class-gate.mjs')
  if (!existsSync(gate)) throw new Error('machine-class-gate: scripts/mnemazine-machine-class-gate.mjs отсутствует')
  await must('machine-class-gate selftest', process.execPath, [gate, '--selftest'])
  const shDir = path.join(ROOT, 'scripts')
  const files = (await fs.readdir(shDir)).filter(f => f.endsWith('.sh'))
  const violations = []
  for (const f of files) {
    const lines = (await fs.readFile(path.join(shDir, f), 'utf8')).split('\n')
    let gateSeen = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().startsWith('#')) continue // комментарий не считается ни вызовом гейта, ни отправкой
      if (line.includes('machine-class-gate')) gateSeen = true
      if (!/\b(rsync|scp)\b/.test(line)) continue
      const tokens = line.trim().split(/\s+/)
      const dest = tokens[tokens.length - 1] // outbound ⇔ VPS is the destination (last arg); inbound pulls have VPS as source
      if (/\$VPS/.test(dest) && !gateSeen) {
        violations.push(`scripts/${f}:${i + 1}: rsync/scp на $VPS без предшествующего вызова machine-class-gate`)
      }
    }
  }
  if (violations.length) throw new Error('machine-class-gate: незащищенная отправка наружу:\n' + violations.join('\n'))
}

// Порог пяти новых гейтов: 'blocking' по умолчанию. Перевод в 'warn' — одна строка
// new_gate_enforcement в config/doc-claims.json (путь отката П11 на исторический долг).
function readNewGateEnforcement() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config', 'doc-claims.json'), 'utf8'))
    return cfg.new_gate_enforcement === 'warn' ? 'warn' : 'blocking'
  } catch {
    return 'blocking'
  }
}

// --contracts: печать контракта всех зарегистрированных проверок без их запуска.
// Строки syntax:<file> перечисляют реальную выборку git ls-files ∩ disk.
async function printContracts(checks) {
  const targets = syntaxTargetsFrom(await gitLsFiles())
  for (const file of targets.all) {
    if (existsSync(path.join(ROOT, file))) console.log(`syntax:${file}`)
  }
  for (const [name] of checks) console.log(`check:${name}`)
}

// --- П19 онбординг: шесть новых проверок --------------------------------------

// Пары двуязычных носителей онбординга. README.md/README.ru.md больше не пишутся
// руками: их рендерит семейный гейт Olympuz из .github/family-page.json, и его
// контракт общий для пяти публичных проектов — гнуть его под один репозиторий
// нельзя. Поэтому разделы контракта П19 сторожатся там, где они теперь лежат:
// пошаговый ход установки в docs/ONBOARDING.*, остальные разделы в docs/DETAILS.*.
const ONBOARDING_DOC_PAIRS = [
  ['README.md', 'README.ru.md'],
  ['docs/ONBOARDING.md', 'docs/ONBOARDING.ru.md'],
  ['docs/DETAILS.md', 'docs/DETAILS.ru.md']
]

async function readOnboardingDocs() {
  const rels = ONBOARDING_DOC_PAIRS.flat()
  const bodies = await Promise.all(rels.map(r => fs.readFile(path.join(ROOT, r), 'utf8')))
  return Object.fromEntries(rels.map((r, i) => [r, bodies[i]]))
}

// Онбординг: семь разделов контракта в docs/DETAILS (обе версии), пошаговый ход
// установки в docs/ONBOARDING (обе версии), одинаковый набор npm-команд EN/RU в
// каждой паре, одинаковое число строк в таблице агентов (заголовочный паритет
// этого не ловит).
async function onboardingReadmeCheck() {
  const docs = await readOnboardingDocs()
  const en = docs['docs/DETAILS.md']; const ru = docs['docs/DETAILS.ru.md']
  const h2 = body => (body.match(/^##\s+.+$/gm) || []).map(s => s.toLowerCase())
  const enH2 = h2(en); const ruH2 = h2(ru)
  const sections = [
    ['my agents', 'мои агенты'],
    ['privacy', 'приватность'],
    ['if you improved me', 'если ты меня улучшил'],
    ['something broke', 'сломалось'],
    ['exit codes', 'коды возврата'],
    ['bot:', 'бот:'],
    ['vps:', 'vps:']
  ]
  const missing = []
  for (const [enA, ruA] of sections) {
    if (!enH2.some(x => x.includes(enA))) missing.push(`docs/DETAILS.md: раздел «${enA}»`)
    if (!ruH2.some(x => x.includes(ruA))) missing.push(`docs/DETAILS.ru.md: раздел «${ruA}»`)
  }

  // Ход установки: в docs/ONBOARDING это не заголовок, а сам пошаговый путь.
  // Сторожим суть, а не имя раздела: заголовок документа, команда установки,
  // не меньше восьми нумерованных шагов, и шагов поровну в EN и RU.
  const steps = body => (body.match(/^\d+\.\s+\*\*/gm) || []).length
  const onboardingHeads = [
    ['docs/ONBOARDING.md', /^#\s+onboarding/im],
    ['docs/ONBOARDING.ru.md', /^#\s+онбординг/im]
  ]
  for (const [rel, head] of onboardingHeads) {
    if (!head.test(docs[rel])) missing.push(`${rel}: нет заголовка онбординга`)
    if (!docs[rel].includes('bash setup.sh')) missing.push(`${rel}: нет команды установки bash setup.sh`)
    if (steps(docs[rel]) < 8) missing.push(`${rel}: ход установки короче восьми шагов (${steps(docs[rel])})`)
  }
  const enSteps = steps(docs['docs/ONBOARDING.md']); const ruSteps = steps(docs['docs/ONBOARDING.ru.md'])
  if (enSteps !== ruSteps) missing.push(`шагов установки EN ${enSteps} ≠ RU ${ruSteps} (docs/ONBOARDING)`)
  if (missing.length) throw new Error('onboarding-readme: нет разделов:\n' + missing.join('\n'))

  // Набор npm-команд сверяем внутри КАЖДОЙ языковой пары: команда, уехавшая из
  // одного документа в другой только в одной из версий, так тоже видна.
  const npmToks = body => body.match(/npm (?:run [\w:-]+|start)/g) || []
  for (const [enRel, ruRel] of ONBOARDING_DOC_PAIRS) {
    const enCmds = [...new Set(npmToks(docs[enRel]))].sort()
    const ruCmds = [...new Set(npmToks(docs[ruRel]))].sort()
    const onlyEn = enCmds.filter(c => !ruCmds.includes(c))
    const onlyRu = ruCmds.filter(c => !enCmds.includes(c))
    if (onlyEn.length || onlyRu.length) {
      throw new Error(`onboarding-readme: набор npm-команд разошелся (${enRel} ↔ ${ruRel}). только EN: ${onlyEn.join(', ') || '—'}; только RU: ${onlyRu.join(', ') || '—'}`)
    }
  }

  // Обязательные контрактные фрагменты: каждый обязан быть в ОБЕИХ версиях (контракт
  // П19, блок «Команда проверки»). Команды сверяем по ЧИСЛУ вхождений во всем наборе
  // документов — набор-симметрия выше не ловит потерю одного из двух дублей
  // (прецедент пробы: удаление одной из двух строк `npm run doctor:full` из RU).
  // Текст — по языковой паре EN|RU на носителе, который его теперь несет.
  const MANDATORY = [
    { name: 'npm run doctor', cmd: 'npm run doctor' },
    { name: 'npm run doctor:full', cmd: 'npm run doctor:full' },
    { name: 'npm start', cmd: 'npm start' },
    { name: 'таблица приватности', en: '| Channel | What leaves', ru: '| Канал | Что уходит' },
    { name: 'VPS не делает: Apple Vision OCR', en: 'Apple Vision', ru: 'Apple Vision' },
    { name: 'VPS не делает: whisper', en: 'whisper', ru: 'whisper' },
    { name: 'VPS не делает: ollama', en: 'ollama', ru: 'ollama' }
  ]
  const allToks = rels => rels.flatMap(r => npmToks(docs[r]))
  const enToks = allToks(ONBOARDING_DOC_PAIRS.map(p => p[0]))
  const ruToks = allToks(ONBOARDING_DOC_PAIRS.map(p => p[1]))
  const gaps = []
  for (const f of MANDATORY) {
    if (f.cmd) {
      const enN = enToks.filter(t => t === f.cmd).length
      const ruN = ruToks.filter(t => t === f.cmd).length
      if (enN === 0) gaps.push(`«${f.name}» → нет ни в одном английском документе онбординга`)
      if (ruN === 0) gaps.push(`«${f.name}» → нет ни в одном русском документе онбординга`)
      if (enN && ruN && enN !== ruN) gaps.push(`«${f.name}» → вхождений EN ${enN} ≠ RU ${ruN}`)
    } else {
      if (!en.includes(f.en)) gaps.push(`«${f.name}» → нет в docs/DETAILS.md`)
      if (!ru.includes(f.ru)) gaps.push(`«${f.name}» → нет в docs/DETAILS.ru.md`)
    }
  }
  if (gaps.length) throw new Error('onboarding-readme: пропал обязательный контрактный фрагмент:\n' + gaps.map(g => '  ' + g).join('\n'))

  const agentRows = (body, anchor) => {
    const lines = body.split('\n')
    const start = lines.findIndex(l => /^##\s/.test(l) && l.toLowerCase().includes(anchor))
    if (start === -1) return -1
    let n = 0
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break
      if (/^\|/.test(lines[i])) n++
    }
    return n
  }
  const enRows = agentRows(en, 'my agents'); const ruRows = agentRows(ru, 'мои агенты')
  if (enRows < 4 || ruRows < 4) throw new Error(`onboarding-readme: таблица агентов пуста (EN ${enRows}, RU ${ruRows})`)
  if (enRows !== ruRows) throw new Error(`onboarding-readme: строк в таблице агентов EN ${enRows} ≠ RU ${ruRows}`)
}

// install.sh реально зовет доктора и не печатает безусловное «installed».
async function installVerifiesCheck() {
  const src = await fs.readFile(path.join(ROOT, 'install.sh'), 'utf8')
  if (!src.includes('mnemazine-doctor')) throw new Error('install-verifies: install.sh не ссылается на mnemazine-doctor')
  if (!src.includes('exit "$STATUS"')) throw new Error('install-verifies: install.sh не завершается кодом статуса')
  if (/^\s*echo\s+"Mnemazine installed\.?"/m.test(src)) throw new Error('install-verifies: безусловная печать «Mnemazine installed» без развилки')
}

// Гейт согласия: молчание = отказ, ничего не создано в $HOME.
async function installerConsentGateCheck() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-consent-home-'))
  const shim = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-consent-shim-'))
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-consent-clone-'))
  for (const c of ['pip3', 'pip', 'launchctl', 'swiftc', 'brew', 'xcode-select']) {
    await fs.writeFile(path.join(shim, c), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  const res = await run('bash', ['install.sh'], {
    env: { HOME: home, PATH: `${shim}:${process.env.PATH}`, MNEMAZINE_ROOT: clone, MNEMAZINE_SETUP_DRYRUN: '0', MNEMAZINE_FROM_SETUP: '0', MNEMAZINE_YES: '0' }
  })
  if (res.code !== 1) throw new Error(`installer-consent-gate: молчание должно давать exit 1, получено ${res.code}\n${res.stdout}\n${res.stderr}`)
  const created = await listFiles(home)
  if (created.length) throw new Error(`installer-consent-gate: отказ создал файлы в $HOME: ${created.join(', ')}`)
}

// Каждая строка DEGRADED: несет команду починки.
async function installerWarningsCarryFixCheck() {
  const lines = (await fs.readFile(path.join(ROOT, 'install.sh'), 'utf8')).split('\n')
  const bad = []
  let degradeCalls = 0
  for (let i = 0; i < lines.length; i++) {
    if (/\bdegrade\s+"/.test(lines[i])) degradeCalls++
    if (lines[i].includes('DEGRADED:') && !lines[i].includes('fix:')) bad.push(`install.sh:${i + 1}: ${lines[i].trim()}`)
  }
  if (bad.length) throw new Error('installer-warnings-carry-fix: DEGRADED без команды:\n' + bad.join('\n'))
  if (degradeCalls < 1) throw new Error('installer-warnings-carry-fix: нет ни одного degrade-вызова')
}

// Доктор различает три кода: 0/1/2.
async function doctorThreeCodesCheck() {
  const src = await fs.readFile(path.join(ROOT, 'scripts/mnemazine-doctor.mjs'), 'utf8')
  if (!/process\.exit\(1\)/.test(src)) throw new Error('doctor-three-codes: нет ветки exit 1')
  if (!/process\.exit\(2\)/.test(src)) throw new Error('doctor-three-codes: нет ветки exit 2')
  if (!/warnings\.length\)\s*process\.exit\(2\)/.test(src)) throw new Error('doctor-three-codes: предупреждения не дают код 2')
  await must('doctor selftest (three codes)', process.execPath, ['scripts/mnemazine-doctor.mjs', '--selftest'])
}

// Интейк: раздел приватности с четырьмя каналами; вопрос про бота исполним в трех
// ветках без сети и без записи в $HOME; тексты не обещают на VPS того, чего нет.
async function onboardingIntakeCheck() {
  const docs = await readOnboardingDocs()
  // Перечисление каналов приема переехало в раздел приватности docs/DETAILS
  // (README рендерит семейный гейт Olympuz). Сверяем ВНУТРИ самого раздела, а не по
  // всему файлу: слово «youtube» где-то в другой главе гарантией не является.
  const privacySection = body => {
    const lines = body.split('\n')
    const start = lines.findIndex(l => /^##\s+.*(privacy|приватность)/i.test(l))
    if (start === -1) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
    return lines.slice(start, end).join('\n')
  }
  for (const rel of ['docs/DETAILS.md', 'docs/DETAILS.ru.md']) {
    const section = privacySection(docs[rel])
    if (section === null) throw new Error(`onboarding-intake: в ${rel} нет раздела приватности`)
    const channels = { deep: /deep/i, telegram: /telegram/i, 'agent-os': /agent-os/i, youtube: /youtube/i }
    for (const [name, re] of Object.entries(channels)) {
      if (!re.test(section)) throw new Error(`onboarding-intake: в ${rel} раздел приватности не называет канал ${name}`)
    }
  }
  // Сторож честности про VPS: ни один пользовательский текст не обещает на сервере
  // того, чего там нет. Носителей теперь шесть, а не два — гарантия шире прежней.
  const vpsClaims = [
    /(Apple Vision|whisper|ollama)[^.\n]{0,80}(VPS|сервер|server|удал[её]нн)/i,
    /(VPS|сервер|server)[^.\n]{0,80}(Apple Vision|whisper|ollama)/i
  ]
  for (const rel of ONBOARDING_DOC_PAIRS.flat()) {
    const lines = docs[rel].split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const re of vpsClaims) {
        if (re.test(lines[i])) throw new Error(`onboarding-intake: ${rel}:${i + 1} обещает на VPS то, чего там нет: ${lines[i].trim()}`)
      }
    }
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-intake-home-'))
  const shim = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-intake-shim-'))
  const netlog = path.join(shim, 'net.log')
  for (const c of ['ssh', 'scp', 'rsync', 'security', 'pip3', 'pip', 'launchctl', 'swiftc', 'brew', 'xcode-select', 'claude', 'codex']) {
    await fs.writeFile(path.join(shim, c), `#!/bin/sh\necho "$(basename "$0") $*" >> ${JSON.stringify(netlog)}\nexit 0\n`, { mode: 0o755 })
  }
  const branches = [
    ['нет VPS', '1\n3\n1\nтокен-проба\n2\n'],
    ['без бота', '1\n3\n2\n'],
    ['есть VPS', '1\n3\n1\nтокен-проба\n1\nuser@host\n\nSHA256:fake\n']
  ]
  for (const [name, answers] of branches) {
    const res = await runWithStdin('bash', ['setup.sh'], answers, {
      HOME: home, PATH: `${shim}:${process.env.PATH}`, MNEMAZINE_SETUP_DRYRUN: '1'
    })
    if (res.code !== 0) throw new Error(`onboarding-intake: ветка «${name}» упала кодом ${res.code}\n${(res.stderr || res.stdout).slice(-500)}`)
  }
  if (existsSync(netlog)) throw new Error('onboarding-intake: установщик сходил в сеть (net.log непустой)')
  const created = await listFiles(home)
  if (created.length) throw new Error(`onboarding-intake: установщик создал файлы в $HOME: ${created.join(', ')}`)
}

async function main() {
  const checks = [
    ['syntax', checkSyntax],
    ['npm-audit', npmAuditCheck],
    ['desktop-dry-run', desktopDryRunSmoke],
    ['poll-retry', pollRetrySmoke],
    ['demo-smoke', demoSmoke],
    ['strict-archive-gate', strictArchiveGateSmoke],
    ['quality-public', qualityAndPublicChecks],
    ['search-eval', searchEvalSmoke],
    ['repo-metadata', repoMetadataCheck],
    ['rules-inventory', rulesInventoryGate],
    ['doc-contract-check', docContractGate],
    ['single-truth-check', singleTruthGate],
    ['lesson-gate', lessonGateCheck],
    ['checks-inventory', checksInventoryGate],
    ['model-pin', modelPinCheck],
    ['tracking-guard', trackingGuardCheck],
    ['machine-class-gate', machineClassGateCheck],
    ['onboarding-readme', onboardingReadmeCheck],
    ['install-verifies', installVerifiesCheck],
    ['installer-consent-gate', installerConsentGateCheck],
    ['installer-warnings-carry-fix', installerWarningsCarryFixCheck],
    ['doctor-three-codes', doctorThreeCodesCheck],
    ['onboarding-intake', onboardingIntakeCheck]
  ]

  if (process.argv.includes('--contracts')) {
    await printContracts(checks)
    return
  }

  // --only <name>: запустить одну зарегистрированную проверку (режим приходит из
  // П19; до его закрытия обслуживает прямой вызов machine-class-gate из приемки П24).
  const onlyIdx = process.argv.indexOf('--only')
  if (onlyIdx !== -1) {
    const requested = String(process.argv[onlyIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean)
    const selected = checks.filter(([n]) => requested.includes(n))
    // Пустая выборка — exit 2, а не «сдано 0/0 ✓»: опечатка в фильтре не должна
    // печатать «прием» (прецедент разбора Фемиды).
    if (selected.length === 0) { console.error(`empty --only selection: ${requested.join(',') || '(none)'}`); process.exit(2) }
    const okOnly = []
    const crashOnly = []
    for (const [name, fn] of selected) {
      try { await fn(); okOnly.push(name); console.log(`ok ${name}`) }
      catch (e) { crashOnly.push(name); console.error(`crash:${name}\n${e && e.message ? e.message : e}`) }
    }
    process.exit(crashOnly.length ? 1 : 0)
  }

  // Изоляция: исключение одной проверки записывается crash:<имя> и не убивает остальные;
  // итоговый код ненулевой при любом crash. Новые гейты при enforcement:'warn' дают warn,
  // а не crash (мягкий режим), но по умолчанию блокируют.
  const enforcement = readNewGateEnforcement()
  const passed = []
  const warned = []
  const crashed = []
  for (const [name, fn] of checks) {
    try {
      await fn()
      passed.push(name)
      console.log(`ok ${name}`)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      if (NEW_CHECKS.has(name) && enforcement === 'warn') {
        warned.push(name)
        console.error(`warn ${name} (мягкий режим): ${message}`)
      } else {
        crashed.push(name)
        console.error(`crash:${name}\n${message}`)
      }
    }
  }
  if (crashed.length) {
    console.log(JSON.stringify({ ok: false, passed, warned, crashed }, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, passed, warned }, null, 2))
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
