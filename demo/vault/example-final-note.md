# Local OCR Before Model Vision

## What This Is

Local OCR extracts readable text from screenshots before an LLM is asked to interpret meaning.

## Why It Matters

OCR is cheaper, faster, and repeatable. It also creates a stable artifact that can be cached.

## How To Use It

Run Apple Vision OCR on macOS for images. Store the raw text in cache, then refine it into a note.

## Source

- Demo source: `demo/inbox/example-guide.md`

## Verification

- Status: demo

## Related Notes

- Graphify memory map
- Screenshot ingestion

## Reuse

- Add this as a step in screenshot ingestion skills.
