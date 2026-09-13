import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { loadRegistry, pickSchemaAdapter } from './mnemazine-cli-router.mjs'

export function resolveExecutable(binary, { env = process.env, home = os.homedir() } = {}) {
  if (typeof binary !== 'string' || !binary || binary.includes('\0')) return null
  const override = env[`MNEMAZINE_${binary.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`]
  const executable = file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() ? path.resolve(file) : null } catch { return null }
  }
  const target = override || binary
  if (target.includes(path.sep)) return executable(path.resolve(target))
  const dirs = [...(env.PATH || '').split(path.delimiter).filter(Boolean),
    path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, '.claude/local'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  for (const dir of dirs) { const found = executable(path.join(dir, target)); if (found) return found }
  return null
}

function cooldownRoot(dir) {
  return dir || process.env.MNEMAZINE_CLI_COOLDOWNS || path.join(os.homedir(), '.mnemazine', 'cli-cooldowns')
}
function providerDir(name, dir) {
  return path.join(cooldownRoot(dir), createHash('sha256').update(name).digest('hex'))
}
export function readCooldown(name, { dir, now = Date.now() } = {}) {
  const folder = providerDir(name, dir)
  let files
  try { files = fs.readdirSync(folder) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  let latest = null
  for (const file of files.filter(file => file.endsWith('.json'))) {
    let record
    try { record = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('CLI cooldown state is unreadable') }
    if (!['quota', 'rate_limit'].includes(record.reason) || !Number.isFinite(record.until)) throw new Error('Invalid CLI cooldown state')
    if (record.until > now && (!latest || record.until > latest.until)) latest = record
  }
  return latest
}
export function recordCooldown(name, reason, { dir, now = Date.now(), retryAfterMs } = {}) {
  if (!['quota', 'rate_limit'].includes(reason)) return null
  const ttl = Math.min(24 * 3600000, Math.max(1000, Number.isFinite(retryAfterMs) ? retryAfterMs : reason === 'quota' ? 5 * 3600000 : 60000))
  const folder = providerDir(name, dir)
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const record = { reason, until: now + ttl }
  // ponytail: immutable per-provider records prevent concurrent shards from
  // overwriting a longer cooldown; readers take the maximum, no stale lock theft.
  const file = path.join(folder, `${randomUUID()}.json`), tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
  const parent = fs.openSync(folder, 'r')
  try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  for (const old of fs.readdirSync(folder).filter(value => value.endsWith('.json'))) {
    try { if (JSON.parse(fs.readFileSync(path.join(folder, old), 'utf8')).until <= now) fs.unlinkSync(path.join(folder, old)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return record
}

export function classifyProcessFailure(result) {
  if (result.status === 0) return null
  if (result.status === 124) return 'timeout'
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
  if (/insufficient_quota|quota.{0,60}(exceed|exhaust|limit)|(?:exceed|exhaust).{0,60}quota|out of credits|credit balance.{0,40}(low|exhaust)|usage limit.{0,40}(reach|exceed)|hit your.{0,30}limit/i.test(output)) return 'quota'
  if (/rate.?limit|too many requests|\b429\b/i.test(output)) return 'rate_limit'
  if (/unauthori[sz]ed|not logged in|authentication required|\b401\b/i.test(output)) return 'auth'
  return 'process_error'
}

export function discoverProviders({ registry = loadRegistry(), env = process.env, home = os.homedir(), cooldownDir } = {}) {
  const providers = Object.entries(registry).map(([name, entry]) => {
    const binary = resolveExecutable(entry.invoke[0], { env, home })
    return { name, installed: Boolean(binary), supported: Boolean(pickSchemaAdapter(entry)), binary,
      model: entry.model, cost_tier: entry.cost_tier, data_classes: entry.data_classes,
      capabilities: entry.capabilities, cooldown: readCooldown(name, { dir: cooldownDir }) }
  })
  for (const name of ['gemini', 'qwen', 'opencode', 'aider', 'goose', 'ollama']) {
    if (registry[name]) continue
    const binary = resolveExecutable(name, { env, home })
    if (binary) providers.push({ name, installed: true, supported: false, binary, cooldown: null })
  }
  return providers
}
