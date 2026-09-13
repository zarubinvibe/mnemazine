import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireVaultLock } from '../scripts/mnemazine-vault-lock.mjs'

const script = fileURLToPath(new URL('../scripts/mnemazine-vault-lock.mjs', import.meta.url))
const root = mkdtempSync(path.join(os.tmpdir(), 'mnemazine-vault-lock-test-'))
const vault = path.join(root, 'vault')
const alias = path.join(root, 'alias')
mkdirSync(vault)
symlinkSync(vault, alias)
const dir = path.join(vault, '.mnemazine-pipeline-lock')
const run = (target, code, env = process.env) => spawnSync(process.execPath,
  [script, '--vault', target, '--', process.execPath, '-e', code], { encoding: 'utf8', env })
let holder
try {
  // A real independent process owns the vault while another uses a symlink.
  holder = spawn(process.execPath, [script, '--vault', vault, '--', process.execPath,
    '-e', 'console.log("ready"); process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve)
    holder.once('error', reject)
    holder.once('exit', code => reject(new Error(`holder exited ${code}`)))
  })
  assert.equal(run(alias, '').status, 75)
  const otherOwner = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8'))
  assert.equal(run(alias, '', { ...process.env, MNEMAZINE_VAULT_LOCK: otherOwner.nonce }).status, 75,
    'knowing nonce does not make an unrelated process a descendant')
  const exit = new Promise(resolve => holder.once('exit', resolve))
  holder.stdin.end()
  assert.equal(await exit, 0)
  assert.equal(existsSync(dir), false)

  const release = acquireVaultLock(vault)
  assert.equal(run(alias, '').status, 0, 'descendant inherits verified lock')
  assert.equal(run(alias, '', { ...process.env, MNEMAZINE_VAULT_LOCK: 'wrong' }).status, 75)
  assert.equal(existsSync(dir), true, 'child must not release parent ownership')
  release()
  assert.equal(run(vault, 'process.exit(7)').status, 7)
  assert.equal(existsSync(dir), false, 'command failure cleans lock')
  const direct = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireVaultLock } from ${JSON.stringify(new URL('../scripts/mnemazine-vault-lock.mjs', import.meta.url).href)}; acquireVaultLock(${JSON.stringify(vault)}); process.exit(9)`])
  assert.equal(direct.status, 9)
  assert.equal(existsSync(dir), false, 'process.exit cleans direct lock')

  mkdirSync(dir)
  writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 2147483647, start: 'stale', nonce: 'stale' }))
  assert.equal(run(vault, '').status, 75)
  assert.equal(existsSync(dir), true, 'stale ownership is never stolen')
  console.log('vault lock: concurrency, aliases, reentrancy, stale and failure cleanup passed')
} finally {
  holder?.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
}
