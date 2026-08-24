#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, '.mnemazine', 'state', 'rebuild', 'public-history-baseline.json')
const CURRENT_VAULT_MARKER = String.fromCharCode(0x041c, 0x043e, 0x0437, 0x0433)

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  })
}

function sh(script, opts = {}) {
  return run('/bin/sh', ['-c', script], opts)
}

function stdout(cmd, args) {
  const res = run(cmd, args)
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || `${cmd} failed`).trim())
  return (res.stdout || '').trim()
}

function hasCommand(name) {
  return sh(`command -v ${name} >/dev/null 2>&1`).status === 0
}

function result(id, ok, detail = '') {
  return { id, ok, detail }
}

function assertNoUntracked() {
  const files = stdout('git', ['ls-files', '--others', '--exclude-standard'])
  return result('A', files.length === 0, files || 'no untracked public files')
}

function assertPackageTargetsTracked() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const tracked = new Set(stdout('git', ['ls-files']).split('\n').filter(Boolean))
  const bad = []
  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    const matches = String(script).match(/(scripts|tests)\/[^\s"]+\.(mjs|sh|py|js)/g) || []
    for (const rel of matches) {
      if (!fs.existsSync(path.join(ROOT, rel)) || !tracked.has(rel)) bad.push(`${name}:${rel}`)
    }
  }
  return result('B', bad.length === 0, bad.join('\n') || 'all package script targets are tracked')
}

function assertPublicCheck() {
  const check = run('bash', ['scripts/check-public-release.sh'])
  const markerList = fs.readFileSync(path.join(ROOT, 'scripts', 'check-public-release.sh'), 'utf8')
  const ok = check.status === 0 && markerList.includes(CURRENT_VAULT_MARKER)
  return result('C', ok, ok ? 'public-check passed and current vault marker is configured' : (check.stderr || check.stdout || 'current vault marker missing').trim())
}

function assertGitleaks() {
  if (!fs.existsSync(BASELINE)) return { fatal: 2, check: result('D', false, `missing ${path.relative(ROOT, BASELINE)}`) }
  if (!hasCommand('gitleaks')) return { fatal: 2, check: result('D', false, 'gitleaks not found') }
  const res = run('gitleaks', ['git', '.', '--config', '.gitleaks.toml', '--no-banner', '--redact', '--log-opts', 'public/main..HEAD'])
  return { check: result('D', res.status === 0, res.status === 0 ? 'gitleaks history scan passed' : (res.stderr || res.stdout || 'gitleaks found leaks').trim()) }
}

function assertPushRefs() {
  const push = stdout('git', ['config', '--get', 'remote.public.push'])
  const refs = stdout('git', ['for-each-ref', '--format=%(refname)'])
    .split('\n')
    .filter(Boolean)
    .filter(ref => !/^refs\/(heads|tags|remotes)\//.test(ref))
  const ok = push === 'refs/heads/main:refs/heads/main' && refs.length === 0
  return result('E', ok, ok ? 'public push is branch-scoped and no extra refs exist' : [`remote.public.push=${push}`, ...refs].join('\n'))
}

function assertRgOrAuditFailsClosed() {
  if (hasCommand('rg')) return result('F', true, 'rg found')
  const env = { ...process.env, MNEMAZINE_AUDIT_SKIP_PUBLIC_RELEASE: '1', PATH: '/usr/bin:/bin' }
  const res = run('bash', ['scripts/mnemazine-audit-local.sh'], { env })
  return result('F', res.status !== 0, res.status !== 0 ? 'audit-local fails closed without rg' : 'audit-local passed with rg hidden')
}

function assertReportGate() {
  const marker = path.join(ROOT, '.mnemazine', 'state', 'rebuild', 'П24.done.json')
  const poll = fs.readFileSync(path.join(ROOT, 'scripts', 'mnemazine-telegram-poll.sh'), 'utf8')
  const legacy = /^\s*\[ -d "\$REPO\/reports" \] && rsync/m.test(poll)
  const ok = fs.existsSync(marker) && !legacy
  return result('G', ok, ok ? 'P24 marker exists and legacy reports rsync is gone' : [
    fs.existsSync(marker) ? '' : 'missing .mnemazine/state/rebuild/П24.done.json',
    legacy ? 'legacy reports rsync still present' : '',
  ].filter(Boolean).join('\n'))
}

const checks = []
let fatal = 0
for (const fn of [
  assertNoUntracked,
  assertPackageTargetsTracked,
  assertPublicCheck,
  assertPushRefs,
  assertRgOrAuditFailsClosed,
  assertReportGate,
]) {
  try {
    checks.push(fn())
  } catch (error) {
    checks.push(result(fn.name, false, error.message || String(error)))
  }
}

const d = assertGitleaks()
checks.splice(3, 0, d.check)
if (d.fatal) fatal = d.fatal

const ok = checks.every(c => c.ok)
const report = { ok, checks }
;(ok ? console.log : console.error)(JSON.stringify(report, null, 2))
process.exit(ok ? 0 : fatal || 1)
