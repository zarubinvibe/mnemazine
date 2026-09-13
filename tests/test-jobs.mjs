import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JobQueue, pipelineFailure } from '../scripts/mnemazine-jobs.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemazine-jobs-test-'))
try {
  const queue = new JobQueue(path.join(tmp, 'queue'))
  const textQueue = new JobQueue(path.join(tmp, 'text-queue'))
  const textInputs = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://example.com/article', 'HTTPS://EXAMPLE.COM/article', 'Мнемозина']
  for (const input of textInputs) {
    const submitted = await textQueue.submit({ kind: 'ingest', mode: 'deep', text: ` ${input} ` })
    assert.equal(submitted.input_text, input)
    assert.equal(submitted.input_kind, /^https:/i.test(input) ? 'url' : 'title')
    assert.equal((await textQueue.submit({ kind: 'ingest', mode: 'deep', text: input })).id, submitted.id)
    assert.notEqual((await textQueue.submit({ kind: 'ingest', mode: 'deep', text: input, project: 'other' })).id, submitted.id)
    assert.equal(submitted.files.length, 1)
    assert.equal(submitted.files[0].original, undefined)
    const snapshot = fs.readFileSync(submitted.files[0].snapshot, 'utf8')
    assert(snapshot.includes(input))
    if (submitted.input_kind === 'url') assert(snapshot.includes(`Источник: ${new URL(input).href}`))
    assert.match(snapshot, /Это запрос на исследование, а не готовое знание/)
    assert(snapshot.length > 80)
    assert.equal(path.dirname(submitted.files[0].snapshot), path.join(textQueue.root, submitted.id, 'sources'))
  }
  for (const input of ['', '  ', 'file:///tmp/private', 'javascript:alert(1)', 'ftp://example.com/file', 'https://user:password@example.com', 'https://', 'https:example.com', 'www.example.com', 'x'.repeat(8193), 'test\u0000']) {
    await assert.rejects(textQueue.submit({ kind: 'ingest', mode: 'deep', text: input }))
  }
  await assert.rejects(textQueue.submit({ kind: 'ingest', mode: 'deep', text: 'Название', files: ['/unused'] }), /either files or text/)
  await assert.rejects(textQueue.submit({ kind: 'search', query: 'поиск', text: 'Название' }), /no intake inputs/)
  const original = path.join(tmp, 'source.md')
  fs.writeFileSync(original, '# Исходный материал\nПамять агентов.')
  await assert.rejects(queue.submit({ kind: 'ingest', files: [original] }), /deep/)
  const job = await queue.submit({ kind: 'ingest', mode: 'deep', files: [original, original] })
  assert.equal(job.files.length, 1)
  assert.equal((await queue.submit({ kind: 'ingest', mode: 'deep', files: [original] })).id, job.id)
  fs.writeFileSync(original, 'Изменённый оригинал')
  assert.match(fs.readFileSync(job.files[0].snapshot, 'utf8'), /Память/)
  await queue.change(job.id, 'cancel')
  assert.equal(queue.read(job.id).status, 'cancelled')
  await queue.change(job.id, 'retry')
  await queue.work({ once: true, execute: async () => { throw new Error('fixture failure') } })
  assert.equal(queue.read(job.id).status, 'failed')
  await queue.change(job.id, 'retry')
  await queue.work({ once: true, execute: async () => ({ text: 'fixture completed' }) })
  assert.equal(queue.read(job.id).status, 'completed')
  assert.equal(fs.readFileSync(original, 'utf8'), 'Изменённый оригинал')
  const pending = await queue.submit({ kind: 'search', query: 'память' })
  await queue.transaction(() => { const j = queue.read(pending.id); j.status = 'running'; queue.save(j, 'fixture_crash') })
  fs.mkdirSync(path.join(queue.root, '.worker-lock'))
  fs.writeFileSync(path.join(queue.root, '.worker-lock/owner.json'), JSON.stringify({ pid: 99999999, started: 'dead' }))
  await queue.work({ once: true, execute: async () => ({ text: 'recovered' }) })
  assert.equal(queue.read(pending.id).status, 'completed')
  assert(queue.read(pending.id).events.some(e => e.event === 'worker_recovered'))
  const orphanJob = await queue.submit({ kind: 'search', query: 'orphan fixture' })
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const exited = new Promise(resolve => orphan.once('exit', resolve))
  try {
    const startedAt = spawnSync('ps', ['-p', String(orphan.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(queue.dir(orphanJob.id), 'process-groups.jsonl'), JSON.stringify({ pid: orphan.pid, started: startedAt }) + '\n')
    await queue.transaction(() => { const j = queue.read(orphanJob.id); j.status = 'running'; queue.save(j, 'fixture_orphan') })
    await queue.work({ once: true, execute: async () => ({ text: 'orphan recovered' }) })
    await exited
    assert.equal(queue.read(orphanJob.id).status, 'completed')
    assert.throws(() => process.kill(orphan.pid, 0), { code: 'ESRCH' })
  } finally { try { process.kill(-orphan.pid, 'SIGKILL') } catch {} }
  const leaderlessJob = await queue.submit({ kind: 'search', query: 'leaderless fixture' })
  const orphanPidFile = path.join(tmp, 'orphan-pid')
  const wrapper = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(orphanPidFile)},String(child.pid));setTimeout(()=>process.exit(0),500)`], { detached: true, stdio: 'ignore' })
  const wrapperExited = new Promise(resolve => wrapper.once('exit', resolve))
  try {
    const startedAt = spawnSync('ps', ['-p', String(wrapper.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(queue.dir(leaderlessJob.id), 'process-groups.jsonl'), JSON.stringify({ pid: wrapper.pid, started: startedAt }) + '\n')
    await wrapperExited
    const grandchildPid = Number(fs.readFileSync(orphanPidFile, 'utf8'))
    process.kill(grandchildPid, 0)
    await queue.transaction(() => { const j = queue.read(leaderlessJob.id); j.status = 'running'; queue.save(j, 'fixture_leader_exited') })
    let executed = false
    await assert.rejects(queue.work({ once: true, execute: async () => { executed = true; return { text: 'unsafe' } } }), /Ambiguous live process group/)
    assert.equal(executed, false)
    assert.equal(queue.read(leaderlessJob.id).status, 'failed')
    assert.equal(queue.read(leaderlessJob.id).recovery_blocked, true)
    assert.match(queue.read(leaderlessJob.id).error, /leader exited/)
    process.kill(grandchildPid, 0)
    await assert.rejects(queue.change(leaderlessJob.id, 'retry'), /Ambiguous live process group/)
    const waiting = await queue.submit({ kind: 'search', query: 'must remain queued behind orphan' })
    await assert.rejects(queue.work({ once: true, execute: async () => { executed = true } }), /Ambiguous live process group/)
    assert.equal(executed, false)
    assert.equal(queue.read(waiting.id).status, 'queued')
    await queue.change(waiting.id, 'cancel')
  } finally { try { process.kill(-wrapper.pid, 'SIGKILL') } catch {} }
  await new Promise(resolve => setTimeout(resolve, 200))
  // Fixture cleanup also removes the intentionally ambiguous historical record.
  fs.writeFileSync(path.join(queue.dir(leaderlessJob.id), 'process-groups.jsonl'), '')
  await queue.change(leaderlessJob.id, 'retry')
  await queue.work({ once: true, execute: async () => ({ text: 'explicit retry after orphan exits' }) })
  const unrelatedJob = await queue.submit({ kind: 'search', query: 'reused leader must not be killed' })
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  try {
    fs.writeFileSync(path.join(queue.dir(unrelatedJob.id), 'process-groups.jsonl'), JSON.stringify({ pid: unrelated.pid, started: 'Thu Jan  1 00:00:00 1970' }) + '\n')
    await queue.transaction(() => { const j = queue.read(unrelatedJob.id); j.status = 'running'; queue.save(j, 'fixture_reused_pid') })
    await queue.work({ once: true, execute: async () => ({ text: 'old group already gone' }) })
    process.kill(unrelated.pid, 0)
  } finally { try { process.kill(-unrelated.pid, 'SIGKILL') } catch {} }
  const concurrent = await queue.submit({ kind: 'search', query: 'one worker' })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let finish
  const finishing = new Promise(resolve => { finish = resolve })
  const first = queue.work({ once: true, execute: async () => { entered(); await finishing; return { text: 'done' } } })
  await started
  assert.equal((await new JobQueue(queue.root).work({ once: true })).worker, 'already_running')
  await queue.change(concurrent.id, 'cancel')
  finish(); await first
  assert.equal(queue.read(concurrent.id).status, 'cancelled')
  await assert.rejects(queue.change('../escape', 'cancel'), /Invalid job id/)
  const link = path.join(tmp, 'symlink.md'); fs.symlinkSync(original, link)
  await assert.rejects(queue.submit({ kind: 'ingest', mode: 'deep', files: [link] }))
  const oversized = path.join(tmp, 'oversized.mp4')
  fs.closeSync(fs.openSync(oversized, 'w')); fs.truncateSync(oversized, 512 * 1024 * 1024 + 1)
  await assert.rejects(queue.submit({ kind: 'ingest', mode: 'deep', files: [oversized] }), /512 MiB/)
  const fifo = path.join(tmp, 'input.fifo')
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
  const fifoSubmit = spawnSync(process.execPath, [path.join(repo, 'scripts/mnemazine-jobs.mjs'), 'submit', '--root', path.join(tmp, 'fifo-queue'), '--kind', 'ingest', '--mode', 'deep', '--file', fifo, '--no-start'], { encoding: 'utf8', timeout: 2000 })
  assert.equal(fifoSubmit.status, 1, 'FIFO must fail promptly instead of blocking open')
  assert.match(fifoSubmit.stderr, /regular file/)

  // Real CLI + real local search against a tiny fixture. No LLM, inbox or live vault.
  const vault = path.join(tmp, 'vault'); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(vault, 'memory.md'), '# Память\nПамять агентов хранит источники.')
  const cliRoot = path.join(tmp, 'cli-queue')
  const cli = args => {
    const out = spawnSync(process.execPath, [path.join(repo, 'scripts/mnemazine-jobs.mjs'), ...args, '--root', cliRoot], {
      encoding: 'utf8', env: { ...process.env, MNEMAZINE_VAULT: vault, MNEMAZINE_DEEP: '1', MNEMAZINE_SEARCH_LOG: path.join(tmp, 'queries.jsonl') },
    })
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
  }
  const search = cli(['submit', '--kind', 'search', '--query', 'память', '--no-start']).job
  cli(['work', '--once'])
  const found = cli(['status', '--id', search.id]).job
  assert.equal(found.status, 'completed')
  assert.match(found.result.text, /memory.md/)
  assert.match(found.result.text, /локальн/)
  assert(found.result.sources.some(source => source.path === path.join(vault, 'memory.md')))
  const titleIntake = cli(['submit', '--kind', 'ingest', '--mode', 'deep', '--text', 'Название для исследования', '--no-start']).job
  assert.equal(titleIntake.input_text, 'Название для исследования')
  assert.equal(titleIntake.status, 'queued')

  // Trusted config cannot redirect isolated paths; fake npm records invocation env.
  const fixtureRepo = path.join(tmp, 'protocol'); fs.mkdirSync(path.join(fixtureRepo, '.mnemazine'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRepo, 'scripts'))
  fs.copyFileSync(path.join(repo, 'scripts/mnemazine-vault-lock.mjs'), path.join(fixtureRepo, 'scripts/mnemazine-vault-lock.mjs'))
  const inbox = path.join(tmp, 'job-inbox'); fs.mkdirSync(inbox); fs.writeFileSync(path.join(inbox, 'a.md'), 'fixture')
  fs.writeFileSync(path.join(fixtureRepo, '.mnemazine/config.local.sh'), 'export MNEMAZINE_INBOX=/wrong\nexport MNEMAZINE_STATE=/wrong\nexport MNEMAZINE_REPORTS=/wrong\nexport MNEMAZINE_ARCHIVE=/wrong\nexport MNEMAZINE_CACHE=/wrong\nexport MNEMAZINE_EXTRACTS=/wrong\nexport MNEMAZINE_RUN_ID=wrong\n')
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nnode -e \'const fs=require("fs");fs.appendFileSync(process.env.PROBE,JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("MNEMAZINE_"))))+"\\n")\'\n', { mode: 0o700 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MNEMAZINE_ROOT: fixtureRepo, MNEMAZINE_VAULT: vault, MNEMAZINE_INBOX: inbox, PROBE: path.join(tmp, 'probe.jsonl') }
  for (const key of ['STATE', 'REPORTS', 'ARCHIVE', 'CACHE', 'EXTRACTS', 'RUN_ID']) env[`MNEMAZINE_${key}`] = path.join(tmp, key)
  const protocol = spawnSync('bash', [path.join(repo, 'scripts/mnemazine-desktop-protocol.sh')], { env, encoding: 'utf8' })
  assert.equal(protocol.status, 0, protocol.stderr)
  const records = fs.readFileSync(env.PROBE, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 2)
  for (const record of records) for (const key of ['INBOX', 'STATE', 'REPORTS', 'ARCHIVE', 'CACHE', 'EXTRACTS', 'RUN_ID']) assert.equal(record[`MNEMAZINE_${key}`], env[`MNEMAZINE_${key}`])
  // Hidden job ancestors are valid inboxes. Short text fails the content gate,
  // not scanning. Disable synthesis explicitly: this probe must never use LLMs.
  for (const [name, content, processed] of [
    ['short', '# Короткая проверка\nПроверяем перенос файла в приложение.', 0],
    ['long', '# Проверка очереди\nПамять агента должна сохранять исходный материал, связывать заметки с проверяемыми источниками и возвращать справку с понятными ссылками на документы.', 1],
    ['url-seed', fs.readFileSync(textQueue.list().find(job => job.input_kind === 'url').files[0].snapshot, 'utf8'), 1],
    ['title-seed', fs.readFileSync(textQueue.list().find(job => job.input_kind === 'title').files[0].snapshot, 'utf8'), 1],
  ]) {
    const root = path.join(tmp, '.hidden-jobs', name)
    fs.mkdirSync(path.join(root, 'inbox'), { recursive: true })
    fs.writeFileSync(path.join(root, 'inbox', 'fixture.md'), content)
    const probe = spawnSync(process.execPath, [path.join(repo, 'scripts/mnemazine-run.mjs'), '--require-deep'], {
      encoding: 'utf8', timeout: 10000, cwd: tmp,
      env: { ...process.env, MNEMAZINE_ROOT: repo, MNEMAZINE_VAULT: vault,
        MNEMAZINE_INBOX: path.join(root, 'inbox'), MNEMAZINE_STATE: path.join(root, 'state'),
        MNEMAZINE_REPORTS: path.join(root, 'reports'), MNEMAZINE_ARCHIVE: path.join(root, 'archive'),
        MNEMAZINE_CACHE: path.join(root, 'cache/hashes.json'), MNEMAZINE_EXTRACTS: path.join(root, 'cache/extracted'),
        MNEMAZINE_DEEP: '0', MNEMAZINE_SYNTHESIZE: '0', MNEMAZINE_FINISH: '0', MNEMAZINE_DRAFT_ONLY: '0',
      },
    })
    assert.equal(probe.status, processed ? 2 : 1, probe.stderr) // No synthesized notes: quality gate must also fail.
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state/last-run.json'), 'utf8'))
    assert.equal(state.inbox, 1)
    assert.equal(state.processed, processed)
    assert.equal(state.failed, 1 - processed)
    assert.equal(state.synthesize.skipped, true)
    const diagnosis = pipelineFailure(root, { code: probe.status })
    if (!processed) assert.match(diagnosis, /Файл прочитан, но текст слишком короткий.*не менее 80/)
    else assert.match(diagnosis, /run vault quality failed/)
    assert(fs.existsSync(path.join(root, 'inbox/fixture.md')), 'fixture source must not be archived')
  }
  console.log('jobs tests passed: copy/dedup, retry/cancel, recovery, worker exclusion, local search, protocol isolation')
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }
