# Миграционный контракт корпуса → NOTE-SPEC

Сгенерировано кодом: `scripts/mnemazine-migration-check.mjs --emit`, 2026-08-23T00:02:21.799Z. Не править руками — переснимать `--emit`.
Спека: `docs/NOTE-SPEC.md` (NOTE-SPEC 2026-07-25 + subject §18 (2026-08-22)). Единая правда состава типов/значений: `scripts/mnemazine-note-spec.mjs (единая правда П05; config/note.schema.json П06 — когда появится, ссылаться на нее, не дублировать)`.
Корпус при съеме: 1514 файлов, frontmatter есть у 1512, нет у 2.

| Старое поле | Нот | Значений | Новое поле | Правило переноса | Требует человека |
|---|---:|---:|---|---|---|
| `type` | 1512 | 4 | `type` | mapType: суффиксное отображение в SPEC_TYPES, умолчание concept; tool-card — только при непустых repo+stars+license+risk; decision механически не ставится; оригинал сохраняется в type_legacy | — |
| `verified` | 1512 | 5 | `verified` | mapVerified: значение→SPEC_VERIFIED (е/е равны); аннотация через пробел/скобку → enum + оригинал в verified_legacy; true/да/подтвержд* и expanded with public sources → подтвержден; пусто/false → не-проверялось; свободный текст → не-проверялось + verified_legacy | — |
| `verification_status` | 598 | 15 | `verified` | mapVerificationStatus: поле схлопывается в verified: и после миграции удаляется | — |
| `type_legacy` | 1350 | 182 | `—` | Археология переогранки — НЕ ТРОГАТЬ: это вход для кампании 3 (legacy-значение говорит о ноте больше, чем выровненный concept) и страховка от неверного отображения | — |
| `## Источники (тело) при пустом source:` | 558 | — | `source: / sources:` | Перенос в source:/sources: ТОЛЬКО если провенанс виден в самой ноте (basename интейк-файла, local-media:<hash>, URL → в sources:) | — |

## Полные правила

### `type`

mapType: суффиксное отображение в SPEC_TYPES, умолчание concept; tool-card — только при непустых repo+stars+license+risk; decision механически не ставится; оригинал сохраняется в type_legacy

Прибор: scripts/mnemazine-normalize-old-frontmatter.mjs (mapType).
Новый enum: concept | tool-card | decision | synthesis | agent-research | reference.

### `verified`

mapVerified: значение→SPEC_VERIFIED (е/е равны); аннотация через пробел/скобку → enum + оригинал в verified_legacy; true/да/подтвержд* и expanded with public sources → подтвержден; пусто/false → не-проверялось; свободный текст → не-проверялось + verified_legacy

Прибор: scripts/mnemazine-normalize-old-frontmatter.mjs (mapVerified).
Новый enum: подтвержден | источник-не-найден | непроверяемо-методом | облако-недоступно | проверено-практикой | не-проверялось.

### `verification_status`

mapVerificationStatus: поле схлопывается в verified: и после миграции удаляется. Частичная проверка → не-проверялось + legacy; verified/подтвержд*/verified-with-public-sources → подтвержден; unknown/assumed/false/пусто → не-проверялось; источник-не-найден и непроверяемо-методом сохраняют одноименные значения. Правило 8 мастера: два поля одной семантики = дубль правды.

Прибор: scripts/mnemazine-migration-check.mjs (mapVerificationStatus; контракт П16).
Новый enum: подтвержден | источник-не-найден | непроверяемо-методом | облако-недоступно | проверено-практикой | не-проверялось.
**Решение: owner-decided-collapse-into-verified-remove-field.**

### `type_legacy`

Археология переогранки — НЕ ТРОГАТЬ: это вход для кампании 3 (legacy-значение говорит о ноте больше, чем выровненный concept) и страховка от неверного отображения.

Прибор: —.

### `## Источники (тело) при пустом source:`

Перенос в source:/sources: ТОЛЬКО если провенанс виден в самой ноте (basename интейк-файла, local-media:<hash>, URL → в sources:). Не виден — поле остается пустым, нота уходит в список следующей волны. source: НЕ ВЫДУМЫВАТЬ (kimi-master.md, кампания 2).

Прибор: кампания 3 (переогранка головой) + scripts/mnemazine-normalize-old-frontmatter.mjs (перенос sources→source).

## Standing legacy mappings

- `type`: `knowledge-note` (38) → `concept` — repo-local fixture/default selftest; знание/заметка без спецполей = concept
- `type`: `knowledge-digest` (1) → `synthesis` — repo-local fixture/default selftest; digest/сводка = synthesis
- `verified`: `expanded with public sources` (23) → `подтвержден` — repo-local fixture/default selftest; публичные источники уже добавлены
- `verified`: `false` (15) → `не-проверялось` — repo-local fixture/default selftest; false не заявляет проверку

## subject (§18 мастер-плана)

Поле subject (§18): enum self|world|mixed. Старый корпус проставляется при переогранке: source_type video|article|repo и нет первого лица в теле → world; не выводится однозначно → mixed (fail-closed); self руками не назначается.

## Проверка покрытия

`node scripts/mnemazine-migration-check.mjs --verify config/migration-contract.json` — каждое значение,
встреченное в корпусе на момент прогона, либо уже в enum спеки, либо покрыто детерминированным правилом,
либо явно помечено «требует человека». Новое непокрытое значение = exit 1.
