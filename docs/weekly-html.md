# Weekly HTML Brief

🇬🇧 **English** · [🇷🇺 Русский](weekly-html.ru.md)

Generate:

```bash
node scripts/mnemazine-weekly-brief-html.mjs
```

The report appears in:

```text
$HOME/Desktop/Mnemazine/reports
```

The default report language is Russian because the first public release was designed around Russian reading flow. The template can be localized.

Card states:

- `Прочитал` means keep the note;
- `В работу` means convert the note into an action;
- `Забыть` means remove or archive it.

The browser stores state locally.
