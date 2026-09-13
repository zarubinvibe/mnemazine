#!/usr/bin/env node
// Coordinator-only bridge. The god sandbox must not expose this CLI or the jobs root.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const jobsCLI = fileURLToPath(new URL('./mnemazine-jobs.mjs', import.meta.url));
const MAX_BYTES = 256 * 1024;
const token = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function core(root, args) {
  try {
    return JSON.parse(execFileSync(process.execPath, [jobsCLI, ...args, '--root', root], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    // Core stderr may contain vault paths or source text; only coordinator diagnostics may expose it.
    throw new Error('JOBS_ERROR: операция очереди не выполнена; проверьте журнал координатора');
  }
}

function view(job) {
  return { job: {
    id: job.id, kind: job.kind, status: job.status, provenance: job.provenance,
    created_at: job.created_at, updated_at: job.updated_at,
    // Ingest logs can mention unrelated vault material. Return a receipt, never those logs.
    result: job.status === 'completed' ? { accepted: true } : null,
    citations: [], error: job.error ? 'Обработка не завершена; подробности у координатора' : null,
  } };
}

export function runAdapter(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    root: { type: 'string' }, god: { type: 'string' }, run: { type: 'string' },
    project: { type: 'string' }, worktree: { type: 'string' }, file: { type: 'string' },
    id: { type: 'string' }, query: { type: 'string' }, mode: { type: 'string' }, 'no-start': { type: 'boolean' },
  } });
  const [command] = positionals;
  if (positionals.length !== 1 || !['submit', 'status', 'cancel', 'retry', 'search', 'brief'].includes(command)) {
    throw new Error('Ожидается submit, status, cancel, retry, search или brief');
  }
  if (!v.root || !isAbsolute(v.root)) throw new Error('--root должен быть абсолютным путём очереди координатора');
  for (const key of ['god', 'run', 'project']) {
    if (!token.test(v[key] ?? '')) throw new Error(`Некорректный --${key}`);
  }
  const provenance = { client: 'olympuz', god: v.god, run: v.run, project: v.project };
  if (command === 'search' || command === 'brief') {
    throw new Error('PROJECT_SCOPE_UNAVAILABLE: поиск для богов закрыт до проверки доступа к корпусу проекта');
  }
  if (command !== 'submit') {
    if (!v.id) throw new Error('Требуется --id');
    const { job } = core(v.root, ['status', '--id', v.id, '--no-start']);
    if (job.kind !== 'ingest' || Object.entries(provenance).some(([key, value]) => job.provenance?.[key] !== value)) {
      throw new Error('JOB_SCOPE_MISMATCH: задача не принадлежит этому запуску бога');
    }
    return view(command === 'status' ? job : core(v.root, [command, '--id', v.id, ...(v['no-start'] ? ['--no-start'] : [])]).job);
  }
  if (!v.worktree || !isAbsolute(v.worktree) || !v.file || !isAbsolute(v.file)) {
    throw new Error('Требуются абсолютные --worktree и --file');
  }
  if (v.mode !== 'deep') throw new Error('Требуется --mode deep: intake использует внешний конвейер; разрешение задаёт координатор');
  const worktree = realpathSync(v.worktree);
  const research = join(worktree, 'research');
  const source = join(realpathSync(dirname(v.file)), basename(v.file));
  const name = basename(source);
  if (!/^agent-research--[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*\.md$/.test(name)
      || !name.startsWith(`agent-research--${v.project}--`)
      || dirname(source) !== research || lstatSync(research).isSymbolicLink()) {
    throw new Error('SOURCE_SCOPE_MISMATCH: нужен agent-research--PROJECT--SLUG.md в worktree/research');
  }
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || realpathSync(research) !== research) {
      throw new Error('Источник должен быть обычным файлом без ссылок, не больше 256 KiB');
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!read) break;
      bytes += read;
    }
    if (bytes > MAX_BYTES) throw new Error('Источник превышает 256 KiB');
    content = buffer.subarray(0, bytes);
  } finally { closeSync(fd); }
  // ponytail: a private temporary snapshot closes the god-file mutation window; core owns persistence.
  const stage = mkdtempSync(join(tmpdir(), 'mnemazine-olympuz-'));
  try {
    const snapshot = join(stage, name);
    // Delivery time lives in job.created_at; stable source bytes preserve core deduplication on retries.
    const stamp = `<!-- olympuz: god=${v.god} run=${v.run} project=${v.project} -->\n`;
    writeFileSync(snapshot, Buffer.concat([Buffer.from(stamp), content]), { mode: 0o600 });
    const { job } = core(v.root, ['submit', '--kind', 'ingest', '--mode', 'deep', '--file', snapshot,
      '--project', v.project, '--provenance', JSON.stringify(provenance), ...(v['no-start'] ? ['--no-start'] : [])]);
    return view(job);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runAdapter(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
