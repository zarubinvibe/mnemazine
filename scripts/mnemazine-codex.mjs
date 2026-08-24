#!/usr/bin/env node
// Back-compat shim. The engine is provider-abstracted in mnemazine-llm.mjs and
// the CLIs live as DATA in config/cli-registry.json. These codex-named exports
// stay for old importers, but they no longer pin a provider — the registry
// default and its fallback chain decide. No provider literal, no branch here.
import { llmJson, llmAvailable, fenceUntrusted } from './mnemazine-llm.mjs'

export { fenceUntrusted, llmAvailable as codexAvailable }
export async function codexJson(prompt, schema, opts = {}) {
  return llmJson(prompt, schema, opts)
}
