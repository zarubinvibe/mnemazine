#!/usr/bin/env node
import { discoverProviders } from './mnemazine-cli-runtime.mjs'
try { console.log(JSON.stringify({ providers: discoverProviders() })) }
catch { console.error('Не удалось прочитать реестр CLI или состояние лимитов.'); process.exitCode = 1 }
