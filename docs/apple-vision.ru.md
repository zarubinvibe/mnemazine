# Apple Vision OCR

🇷🇺 **Русский** · [🇬🇧 English](apple-vision.md)

На macOS Mnemazine может использовать Apple Vision framework для локального OCR.

Компиляция:

```bash
swiftc -O skills/mnemazine/vision-ocr.swift -o .mnemazine/bin/vision-ocr
```

Запуск:

```bash
.mnemazine/bin/vision-ocr path/to/image.png
```

Вывод OCR — сырье. Его нужно огранить до попадания в vault.
