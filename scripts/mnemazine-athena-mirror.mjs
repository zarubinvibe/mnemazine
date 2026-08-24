#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function hasFlag(name) {
  return argv.includes(`--${name}`)
}

function arg(name, fallback = '') {
  const hit = argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function args(name) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === `--${name}`) out.push(argv[++i] || '')
    else if (item.startsWith(`--${name}=`)) out.push(item.split('=').slice(1).join('='))
  }
  return out.filter(Boolean)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function parseManifest(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+#.*$/, '').trim())
    .filter(line => line && !line.startsWith('#'))
}

const FORBIDDEN_TARGET_PATTERNS = [
  /^\.env(?:\.|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.git(?:\/|$)/,
  /(^|\/)node_modules(?:\/|$)/,
  /(^|\/)\.ssh(?:\/|$)/,
  /(^|\/)\.mnemazine\/(archive|backlog|cache|config(?:\.|\/|$)|config\.env|known_hosts|quarantine|rebuild|state|tmp)(?:\/|$)/,
  /(^|\/)\.codex\/sessions(?:\/|$)/,
  /(^|\/)\.claude\/projects(?:\/|$)/,
  /(^|\/)reports(?:\/|$)/,
  /(^|\/)graphify-out\/cache(?:\/|$)/
]

const FORBIDDEN_NAME = /(^|[/._-])(secret|secrets|token|tokens|credential|credentials|password|passwd|keychain|private-key|id_rsa|oauth)([/._-]|$)/i
const TOKEN_LIKE = /gh[opusr]_[A-Za-z0-9_]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(AKIA|ASIA)[A-Z0-9]{16}|glpat-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/

function cleanRel(rel, label = 'path') {
  if (!rel || rel.includes('\0')) throw new Error(`empty or invalid ${label}`)
  if (path.isAbsolute(rel)) throw new Error(`absolute ${label} is not allowed: ${rel}`)
  const normalized = path.posix.normalize(rel.replaceAll('\\', '/'))
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${label} escapes root: ${rel}`)
  }
  return normalized
}

function assertAllowedTarget(target) {
  const hit = FORBIDDEN_TARGET_PATTERNS.find(re => re.test(target))
  if (hit || FORBIDDEN_NAME.test(target)) throw new Error(`forbidden mirror target: ${target}`)
}

function parseEntry(line, { home }) {
  const [kind, rest] = line.includes(':') ? line.split(/:(.*)/s) : ['home', line]
  const sourceRel = cleanRel(rest, 'manifest path')
  if (kind === 'repo') {
    const target = cleanRel(path.posix.join('Проекты/mnemazine', sourceRel), 'target')
    assertAllowedTarget(target)
    return { kind, source: path.join(ROOT, sourceRel), target }
  }
  if (kind === 'home') {
    const target = cleanRel(sourceRel, 'target')
    assertAllowedTarget(target)
    return { kind, source: path.join(home, sourceRel), target }
  }
  throw new Error(`unknown manifest entry kind "${kind}" in: ${line}`)
}

async function readManifest(file, { home, repoOnly = false } = {}) {
  const raw = await fs.readFile(file, 'utf8')
  const entries = parseManifest(raw).map(line => parseEntry(line, { home }))
  return repoOnly ? entries.filter(entry => entry.kind === 'repo') : entries
}

async function scanPayload(entry) {
  if (FORBIDDEN_NAME.test(path.basename(entry.source))) throw new Error(`forbidden mirror source name: ${entry.source}`)
  const stat = await fs.lstat(entry.source)
  if (!stat.isFile()) throw new Error(`mirror source is not a regular file: ${entry.source}`)
  if (stat.isSymbolicLink()) throw new Error(`mirror source symlink refused: ${entry.source}`)
  const body = await fs.readFile(entry.source, 'utf8').catch(() => '')
  if (TOKEN_LIKE.test(body)) throw new Error(`token-like payload refused: ${entry.target}`)
}

async function stageEntries(entries, stageRoot) {
  for (const entry of entries) {
    await scanPayload(entry)
    const target = path.join(stageRoot, entry.target)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(entry.source, target)
  }
}

function sshArgs({ sshKey, knownHosts, sshOptions }) {
  const out = ['ssh', '-o', 'BatchMode=yes']
  if (sshKey) out.push('-i', sshKey)
  if (knownHosts) out.push('-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes')
  out.push(...sshOptions.flatMap(item => ['-o', item]))
  return out
}

function buildRsyncArgs({ dest, sshKey, knownHosts, sshOptions, dryRun }) {
  return [
    '-av',
    ...(dryRun ? ['-n'] : []),
    '-e', sshArgs({ sshKey, knownHosts, sshOptions }).map(shellQuote).join(' '),
    './',
    dest
  ]
}

function run(command, commandArgs, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd, env: process.env, stdio: 'inherit' })
    child.on('close', code => resolve(code ?? 1))
    child.on('error', error => {
      console.error(error.message)
      resolve(1)
    })
  })
}

async function selftest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-mirror-selftest-'))
  const repo = path.join(temp, 'repo')
  const home = path.join(temp, 'home')
  await fs.mkdir(path.join(repo, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(home, '.agents'), { recursive: true })
  await fs.writeFile(path.join(repo, 'package.json'), '{}\n', 'utf8')
  await fs.writeFile(path.join(home, '.agents/SHARED.md'), '# shared\n', 'utf8')
  const manifest = path.join(temp, 'manifest.txt')
  await fs.writeFile(manifest, 'repo:package.json\nhome:.agents/SHARED.md\n', 'utf8')
  const entries = await readManifest(manifest, { home })
  if (entries.length !== 2 || entries[0].target !== 'Проекты/mnemazine/package.json') throw new Error('selftest manifest mapping failed')
  const stage = path.join(temp, 'stage')
  await stageEntries(entries, stage)
  if (!existsSync(path.join(stage, 'Проекты/mnemazine/package.json'))) throw new Error('selftest staging repo file failed')
  const repoOnly = await readManifest(manifest, { home: path.join(temp, 'clean-home'), repoOnly: true })
  if (repoOnly.length !== 1) throw new Error('selftest repo-only failed')
  for (const bad of ['home:.env', 'home:.ssh/id_rsa', 'repo:../x', 'repo:secret-token.txt']) {
    let threw = false
    try { parseEntry(bad, { home }) } catch { threw = true }
    if (!threw) throw new Error(`selftest accepted forbidden entry: ${bad}`)
  }
  const rsync = buildRsyncArgs({ dest: 'host:/x/', sshKey: '/k', knownHosts: '/known hosts', sshOptions: ['Port=22'], dryRun: true })
  if (!rsync.includes('-n') || rsync.join(' ').includes(`StrictHostKeyChecking=${'no'}`)) throw new Error('selftest rsync args failed')
  await fs.rm(temp, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true }, null, 2))
}

async function main() {
  if (hasFlag('selftest')) return selftest()
  if (arg('ssh-options')) throw new Error('--ssh-options is unsafe for quoted values; use repeated --ssh-option Name=value or MNEMAZINE_MIRROR_SSH_OPTIONS_JSON.')

  const manifest = path.resolve(arg('manifest', process.env.MNEMAZINE_MIRROR_MANIFEST || path.join(ROOT, 'config/athena-mirror-manifest.txt')))
  const home = path.resolve(arg('home', process.env.MNEMAZINE_MIRROR_HOME || os.homedir()))
  const dest = arg('dest', process.env.MNEMAZINE_MIRROR_DEST || '')
  const sshKey = arg('ssh-key', process.env.MNEMAZINE_MIRROR_SSH_KEY || '')
  const knownHosts = arg('known-hosts', process.env.MNEMAZINE_MIRROR_KNOWN_HOSTS || '')
  const envOptions = process.env.MNEMAZINE_MIRROR_SSH_OPTIONS_JSON ? JSON.parse(process.env.MNEMAZINE_MIRROR_SSH_OPTIONS_JSON) : []
  const sshOptions = [...args('ssh-option'), ...envOptions]
  const apply = hasFlag('apply')
  const dryRun = !apply || hasFlag('dry-run')
  const repoOnly = hasFlag('repo-only')
  const entries = await readManifest(manifest, { home, repoOnly })
  const missing = entries.filter(entry => !existsSync(entry.source))
  if (missing.length) throw new Error(`mirror manifest has missing files:\n${missing.map(item => `- ${item.kind}:${item.target}`).join('\n')}`)
  if (hasFlag('check')) {
    for (const entry of entries) await scanPayload(entry)
    console.log(JSON.stringify({ ok: true, manifest, home, repo: ROOT, entries: entries.length, repo_only: repoOnly }, null, 2))
    return
  }
  if (!dest) throw new Error('Set MNEMAZINE_MIRROR_DEST or pass --dest host:/path/. Default run is dry-run; add --apply for remote write.')
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-mirror-stage-'))
  try {
    await stageEntries(entries, stage)
    const rsync = buildRsyncArgs({ dest, sshKey, knownHosts, sshOptions, dryRun })
    console.log(JSON.stringify({ ok: true, dry_run: dryRun, manifest, files: entries.length, dest, stage }, null, 2))
    const code = await run('rsync', rsync, stage)
    process.exit(code)
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
