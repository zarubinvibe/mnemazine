#!/usr/bin/env node
import { realpathSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENV = 'MNEMAZINE_VAULT_LOCK'
function identity(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}
function descendant(pid) {
  let current = process.pid
  for (let depth = 0; current > 1 && depth < 128; depth++) {
    if (current === pid) return true
    const result = spawnSync('ps', ['-p', String(current), '-o', 'ppid='], { encoding: 'utf8' })
    current = Number(result.stdout?.trim())
  }
  return false
}
function location(vault) {
  return path.join(realpathSync(vault), '.mnemazine-pipeline-lock')
}
export function ownsVaultLock(vault) {
  try {
    const owner = JSON.parse(readFileSync(path.join(location(vault), 'owner.json'), 'utf8'))
    return owner.nonce === process.env[ENV] && Number.isInteger(owner.pid) &&
      owner.start && identity(owner.pid) === owner.start && descendant(owner.pid)
  } catch { return false }
}
export function acquireVaultLock(vault) {
  if (ownsVaultLock(vault)) return () => {}
  const dir = location(vault)
  const owner = { pid: process.pid, start: identity(process.pid), nonce: randomUUID() }
  if (!owner.start) throw new Error('Cannot determine pipeline process identity')
  try { mkdirSync(dir, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    // ponytail: never steal stale locks; manual recovery avoids ABA races.
    const busy = new Error(`Vault pipeline busy or interrupted: ${dir}. Retry after the running pipeline; inspect a stale lock before manual recovery.`)
    busy.code = 'MNEMAZINE_VAULT_BUSY'
    throw busy
  }
  try { writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }) }
  catch (error) { try { rmdirSync(dir) } catch {} ; throw error }
  const previous = process.env[ENV]
  process.env[ENV] = owner.nonce
  let released = false
  const release = () => {
    if (released) return
    released = true
    process.removeListener('exit', release)
    try {
      if (JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')).nonce === owner.nonce) {
        unlinkSync(path.join(dir, 'owner.json'))
        rmdirSync(dir)
      }
    } catch {}
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
  }
  // Cancellation can leave grandchildren draining: retain the lock for inspection.
  release.abandon = () => { released = true; process.removeListener('exit', release) }
  process.once('exit', release)
  return release
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const vault = args[1]
  if (args[0] === '--check') process.exit(ownsVaultLock(vault) ? 0 : 1)
  try {
    if (args[0] !== '--vault' || args[2] !== '--' || !args[3]) throw new Error('Usage: --vault PATH -- COMMAND [ARGS]')
    const release = acquireVaultLock(vault)
    const child = spawn(args[3], args.slice(4), { stdio: 'inherit', env: process.env })
    // Keep ownership until the child exits, including while cancellation drains it.
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
    const handlers = signals.map(signal => () => { release.abandon?.(); child.kill(signal) })
    signals.forEach((signal, i) => process.on(signal, handlers[i]))
    const finish = code => {
      signals.forEach((signal, i) => process.removeListener(signal, handlers[i]))
      release()
      process.exitCode = code
    }
    child.once('error', error => { console.error(error.message); finish(1) })
    child.once('exit', (code, signal) => finish(code ?? (signal === 'SIGINT' ? 130 : 143)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = error.code === 'MNEMAZINE_VAULT_BUSY' ? 75 : 1
  }
}
