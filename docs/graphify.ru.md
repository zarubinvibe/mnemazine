# Graphify

🇷🇺 **Русский** · [🇬🇧 English](graphify.md)

Установка:

```bash
python3 -m pip install graphifyy
```

Обновить граф:

```bash
graphify update ~/Desktop/Mnemazine/vault
```

Защищённое обновление для ночных/ремонтных прогонов Mnemazine:

```bash
export MNEMAZINE_VAULT="/path/to/your/vault"
node scripts/mnemazine-refresh-graphify.mjs --vault "$MNEMAZINE_VAULT" --mode auto --json
```

Живые inbox-прогоны используют code mode и запускают семантическую экстракцию фоновой задачей:

```bash
npm run graph:semantic:async
npm run graph:semantic:monitor
npm run graph:semantic:status
npm run graph:semantic:status:pretty
npm run doctor:watch
```

Status включает `progress`: completed jobs, active shard, failed logs и ETA.
`status:pretty` даёт короткий человекочитаемый вид с PID и elapsed time.
`doctor:watch` ждёт остановки фоновой задачи.
Shard-прогоны по умолчанию resume-able: успешные shard outputs получают
`.done.json` markers, а per-file semantic cache лежит в `.mnemazine/semantic-cache`.
`graph:semantic:monitor` продолжает pending/failed/dead задачи или старые
`needs_update` markers после `--stale-hours` / `MNEMAZINE_SEMANTIC_MONITOR_STALE_HOURS`.
`npm run graph:semantic:async -- --fresh`, `--no-resume` или `--no-cache`
нужны только для намеренно чистого перезапуска.

По умолчанию async semantic refresh идёт через локальные shards/swarm. Так
Mnemazine не гонит один огромный Ollama extract на 1160 заметок и не упирается
в timeout. Старый single-run путь можно включить явно:

```bash
MNEMAZINE_SEMANTIC_TASK_STRATEGY=full npm run graph:semantic:async
```

Что делает обёртка:

- запускает code-safe `graphify update`;
- определяет, осталась ли семантическая свежесть в ожидании;
- по умолчанию запускает локальные semantic shards, затем merge и re-cluster;
- продолжает завершённые shards и переиспользует per-file semantic cache;
- для локального Ollama нормализует базовый URL до `/v1` перед OpenAI-совместимыми вызовами;
- смоук-тестит кандидатные модели и chat-JSON, и мини `graphify extract` до тяжёлой семантической экстракции;
- проходит лестницу моделей из `--models` / `MNEMAZINE_GRAPHIFY_MODELS`;
- делает бэкап `graphify-out/`;
- восстанавливает бэкап и пишет `graphify-out/needs_update`, если семантическое обновление выглядит небезопасным;
- перекластеризует отчёт, чтобы `graph.json` и `GRAPH_REPORT.md` оставались честными.

Коды выхода:

- `0` = граф свежий;
- `2` = частичный успех, семантическое обновление ещё в ожидании;
- `1` = жёсткий сбой.

Дефолты лежат в `config/graphify-refresh.json`.

Семантическая экстракция через отдельный API:

```bash
OPENAI_API_KEY=... node scripts/mnemazine-refresh-graphify.mjs --backend openai --model gpt-4.1-mini --mode semantic --json
ANTHROPIC_API_KEY=... node scripts/mnemazine-refresh-graphify.mjs --backend claude --mode semantic --json
GEMINI_API_KEY=... node scripts/mnemazine-refresh-graphify.mjs --backend gemini --mode semantic --json
```

Ключи не коммитить. Wrapper проверяет нужную переменную окружения, запускает
мини-smoke `graphify extract`, делает бэкап `graphify-out/` и восстанавливает
его, если semantic extraction падает или небезопасно уменьшает граф.

Смоук-тест:

```bash
npm run graph:smoke
```

Graphify помогает Mnemazine:

- находить связанные заметки;
- выявлять кластеры;
- избегать дублирующихся концепций;
- строить граф-осведомлённый контекст для агентов.
