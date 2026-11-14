#!/usr/bin/env node
// Lists models that a gateway serves but the fork's model registry has no
// profile for yet. Output is the starting point for the daily registry refresh
// (see fork/MAINTENANCE.md); it never edits the registry itself.
//
// Sources (each compared with its own profiles/<base>/ folder):
//   openrouter  GET https://openrouter.ai/api/v1/models      (public)
//   vercel      GET https://ai-gateway.vercel.sh/v1/models   (public)
//
// Usage: node fork/registry-candidates.mjs <registry-dir> [--days 60] [--source openrouter,vercel] [--json]

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const registryDir = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !a.includes(','))
    ?? args.find((a) => !a.startsWith('--'))
if (!registryDir || !existsSync(join(registryDir, 'profiles'))) {
    console.error('usage: node fork/registry-candidates.mjs <registry-dir> [--days 60] [--source openrouter,vercel] [--json]')
    process.exit(2)
}
const option = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
}
const days = Number(option('--days') ?? 60)
const asJson = args.includes('--json')
const cutoff = Date.now() / 1000 - days * 86400

// Model families the registry tracks; community fine-tunes and routers are skipped.
const SOURCES = {
    openrouter: {
        url: 'https://openrouter.ai/api/v1/models',
        vendors: new Set([
            'openai', 'anthropic', 'google', 'x-ai', 'deepseek', 'qwen', 'moonshotai',
            'z-ai', 'minimax', 'mistralai', 'meta-llama', 'xiaomi', 'stepfun-ai', 'baidu',
        ]),
        normalize: (m) => ({
            id: m.id,
            name: m.name,
            date: m.created ?? 0,
            type: 'language',
            contextLength: m.context_length ?? null,
            maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
            inputModalities: m.architecture?.input_modalities ?? [],
            tokenizer: m.architecture?.tokenizer ?? null,
            supportedParameters: m.supported_parameters ?? [],
            reasoning: m.reasoning ?? null,
            expirationDate: m.expiration_date ?? null,
        }),
    },
    vercel: {
        url: 'https://ai-gateway.vercel.sh/v1/models',
        vendors: new Set([
            'openai', 'anthropic', 'google', 'xai', 'deepseek', 'alibaba', 'moonshotai',
            'zai', 'minimax', 'mistral', 'meta', 'xiaomi', 'stepfun', 'baidu',
        ]),
        normalize: (m) => ({
            id: m.id,
            name: m.name,
            // `released` is the model's release; `created` is when Vercel listed it.
            date: m.released ?? m.created ?? 0,
            type: m.type,
            contextLength: m.context_window ?? null,
            maxOutputTokens: m.max_tokens ?? null,
            inputModalities: m.modalities?.input ?? [],
            tokenizer: null,
            supportedParameters: m.supported_parameters ?? [],
            tags: m.tags ?? [],
            reasoning: m.reasoning_options ?? null,
            expirationDate: null,
        }),
    },
}

const selected = (option('--source') ?? 'openrouter,vercel').split(',').map((s) => s.trim()).filter(Boolean)
for (const name of selected) {
    if (!SOURCES[name]) {
        console.error(`unknown source: ${name} (known: ${Object.keys(SOURCES).join(', ')})`)
        process.exit(2)
    }
}

function readProfiles(dir) {
    const out = []
    for (const base of readdirSync(join(dir, 'profiles'))) {
        const baseDir = join(dir, 'profiles', base)
        for (const file of readdirSync(baseDir)) {
            if (!file.endsWith('.json')) continue
            const profile = JSON.parse(readFileSync(join(baseDir, file), 'utf8'))
            out.push({ base, file, id: profile.id, modelId: profile.modelId ?? '' })
        }
    }
    return out
}

const profiles = readProfiles(registryDir)
const result = { registryProfiles: profiles.length, days, sources: {} }
let failed = false

for (const name of selected) {
    const source = SOURCES[name]
    const known = new Set(profiles.filter((p) => p.base === name).map((p) => p.modelId.toLowerCase()))
    let data
    try {
        const res = await fetch(source.url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        data = (await res.json()).data
    } catch (error) {
        result.sources[name] = { error: `${source.url}: ${error.message}` }
        failed = true
        continue
    }
    const candidates = data
        .filter((m) => source.vendors.has(m.id.split('/')[0]))
        .filter((m) => !m.id.includes(':')) // skip :free / :beta variants
        .filter((m) => !/-batch$/.test(m.id)) // batch-API variants cannot serve chat
        .map(source.normalize)
        .filter((m) => m.type === 'language')
        .filter((m) => m.date >= cutoff)
        .filter((m) => !known.has(m.id.toLowerCase()))
        .sort((a, b) => b.date - a.date)
        .map((m) => ({ ...m, date: new Date(m.date * 1000).toISOString().slice(0, 10) }))
    result.sources[name] = { profiles: known.size, candidates }
}

if (asJson) {
    console.log(JSON.stringify(result, null, 2))
} else {
    console.log(`registry profiles: ${profiles.length}; window: last ${days} days`)
    for (const [name, entry] of Object.entries(result.sources)) {
        if (entry.error) {
            console.log(`\n[${name}] FAILED: ${entry.error}`)
            continue
        }
        console.log(`\n[${name}] ${entry.profiles} profiles; ${entry.candidates.length} new models without a ${name} profile`)
        for (const c of entry.candidates) {
            console.log(`${c.date}  ${c.id}  ctx=${c.contextLength} out=${c.maxOutputTokens}${c.tokenizer ? ` tok=${c.tokenizer}` : ''}`)
        }
    }
}
process.exit(failed ? 1 : 0)
