#!/usr/bin/env node
// Eval harness for the KB search skill (§5: a skill without evals is not a
// skill). Two tiers, split by token cost:
//   Tier A — deterministic, 0 tokens (runs in release-check, every time):
//            representative queries over a synthetic fixture vault; assert
//            recall (mustHit) and anti-noise (mustMiss) on the local path.
//   Tier B — LLM judge, opt-in (`--deep`, pre-merge only): a separate evaluator
//            agent scores the deep "Справка" for groundedness/relevance/coverage
//            (generator != evaluator, §4). Bounded: tiny fixture, few queries.
// Fixtures are generated inline — reproducible, public-safe, no live-vault PII.
//   node tests/search-eval.mjs            # Tier A only (free)
//   node tests/search-eval.mjs --deep     # + Tier B judge (spends tokens)
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'mnemazine-kb-search.mjs')
const DEEP = process.argv.includes('--deep')

// Synthetic corpus: 3 on-topic clusters + 2 noise notes.
const FIXTURES = {
  'harness-vs-model.md': '# Harness важнее модели\nСреда и workflow дают до 90% выигрыша. Контекст это бюджет, не свалка. Чинить harness, не менять модель.',
  'context-budget.md': '# Контекст как бюджет\n73% токенов уходят до промпта; токены тратятся до запроса. CLAUDE.md короткий роутер до 200 строк. Субагенты изолируют контекст.',
  'swarm-fan-out.md': '# Рой и fan-out\nOrchestrator-worker, recon до fan-out, read параллельно write изолировать. Рой ~15x токенов, оправдан при независимости.',
  'autonomy-loops.md': '# Автономные петли\nCircuit breaker и cost cap, keep-or-revert, generator не равно evaluator, status-файлы.',
  'coffee.md': '# Кофе\nЭспрессо, молоко, ростер, обжарка зерна.',
  'family.md': '# Семья\nДочки, выходные, прогулки в парке, личное время.'
}

const CASES = [
  { topic: 'harness важнее модели', mustHit: ['harness-vs-model.md'], mustMiss: ['coffee.md', 'family.md'] },
  { topic: 'контекст токены бюджет', mustHit: ['context-budget.md'], mustMiss: ['coffee.md'] },
  { topic: 'рой агентов fan-out параллелизм', mustHit: ['swarm-fan-out.md'], mustMiss: ['family.md'] },
  { topic: 'автономные петли circuit breaker', mustHit: ['autonomy-loops.md'], mustMiss: ['coffee.md', 'family.md'] }
]

function runSearch(topic, vault, outDir, deep) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MNEMAZINE_DEEP: deep ? '1' : '' }
    const child = spawn('node', [SCRIPT, '--topic', topic, '--vault', vault, '--out', outDir], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`search exited ${code}`)))
  })
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kbsearch-eval-'))
  const vault = path.join(tmp, 'vault'), outDir = path.join(tmp, 'reports')
  await fs.mkdir(vault, { recursive: true })
  for (const [name, body] of Object.entries(FIXTURES)) await fs.writeFile(path.join(vault, name), body, 'utf8')

  let pass = 0, fail = 0
  const failures = []

  // --- Tier A: deterministic recall/precision (0 tokens) ---
  for (const c of CASES) {
    const reportPath = await runSearch(c.topic, vault, outDir, false)
    const md = await fs.readFile(reportPath, 'utf8')
    for (const hit of c.mustHit) {
      if (md.includes(hit)) pass++
      else { fail++; failures.push(`[A] "${c.topic}" MISSED ${hit}`) }
    }
    for (const miss of c.mustMiss) {
      if (!md.includes(miss)) pass++
      else { fail++; failures.push(`[A] "${c.topic}" LEAKED noise ${miss}`) }
    }
  }
  console.log(`Tier A (0-token): ${pass} pass, ${fail} fail`)

  // --- Tier B: LLM judge on the deep report (opt-in) ---
  if (DEEP) {
    const { llmAvailable, llmJson, fenceUntrusted } = await import('../scripts/mnemazine-llm.mjs')
    if (!llmAvailable()) {
      console.log('Tier B skipped: no LLM available')
    } else {
      const corpus = Object.entries(FIXTURES).map(([n, b]) => `### ${n}\n${b}`).join('\n\n')
      const RUBRIC = {
        type: 'object', additionalProperties: false,
        required: ['groundedness', 'relevance', 'coverage'],
        properties: {
          groundedness: { type: 'integer', minimum: 1, maximum: 5 },
          relevance: { type: 'integer', minimum: 1, maximum: 5 },
          coverage: { type: 'integer', minimum: 1, maximum: 5 },
          notes: { type: 'string' }
        }
      }
      const THRESHOLD = 3
      for (const c of CASES.slice(0, 2)) { // bound token cost: 2 deep queries
        const reportPath = await runSearch(c.topic, vault, outDir, true)
        const md = await fs.readFile(reportPath, 'utf8')
        const judge = await llmJson(
          `Ты строгий судья качества справки по теме "${c.topic}". Оцени 1-5: groundedness (все опирается на корпус, ничего не выдумано), relevance (по теме), coverage (покрыты ключевые моменты корпуса). Верни числа + notes.

КОРПУС:
${fenceUntrusted('CORPUS', corpus)}

СПРАВКА:
${fenceUntrusted('REPORT', md)}`,
          RUBRIC, {}
        )
        const min = Math.min(judge.groundedness, judge.relevance, judge.coverage)
        if (min >= THRESHOLD) { pass++; console.log(`Tier B "${c.topic}": g${judge.groundedness}/r${judge.relevance}/c${judge.coverage} ✓`) }
        else { fail++; failures.push(`[B] "${c.topic}" below threshold: g${judge.groundedness}/r${judge.relevance}/c${judge.coverage} — ${judge.notes || ''}`) }
      }
    }
  }

  await fs.rm(tmp, { recursive: true, force: true })
  if (failures.length) { console.error('\nFAILURES:\n' + failures.join('\n')); process.exit(1) }
  console.log(`\neval ok — ${pass} checks passed`)
}

main().catch(e => { console.error(e.message); process.exit(1) })
