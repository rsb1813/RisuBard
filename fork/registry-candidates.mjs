#!/usr/bin/env node
// Lists models that OpenRouter serves but the fork's model registry has no
// profile for yet. Output is the starting point for the daily registry refresh
// (see fork/MAINTENANCE.md); it never edits the registry itself.
//
// Usage: node fork/registry-candidates.mjs <registry-dir> [--days 60] [--json]

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const registryDir = args.find((a) => !a.startsWith('--'))
if (!registryDir || !existsSync(join(registryDir, 'profiles'))) {
    console.error('usage: node fork/registry-candidates.mjs <registry-dir> [--days 60] [--json]')
    process.exit(2)
}
const daysIndex = args.indexOf('--days')
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 60
const asJson = args.includes('--json')

// Vendors the registry tracks. Community fine-tunes and routers are skipped.
const VENDORS = new Set([
    'openai', 'anthropic', 'google', 'x-ai', 'deepseek', 'qwen', 'moonshotai',
    'z-ai', 'minimax', 'mistralai', 'meta-llama', 'xiaomi', 'stepfun-ai', 'baidu',
])

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
const openrouterIds = new Set(
    profiles.filter((p) => p.base === 'openrouter').map((p) => p.modelId.toLowerCase()),
)

const res = await fetch('https://openrouter.ai/api/v1/models')
if (!res.ok) {
    console.error(`OpenRouter models request failed: HTTP ${res.status}`)
    process.exit(1)
}
const { data } = await res.json()
const cutoff = Date.now() / 1000 - days * 86400

const candidates = data
    .filter((m) => VENDORS.has(m.id.split('/')[0]))
    .filter((m) => !m.id.includes(':')) // skip :free / :beta variants
    .filter((m) => (m.created ?? 0) >= cutoff)
    .filter((m) => !openrouterIds.has(m.id.toLowerCase()))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({
        id: m.id,
        name: m.name,
        created: new Date((m.created ?? 0) * 1000).toISOString().slice(0, 10),
        contextLength: m.context_length,
        maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
        inputModalities: m.architecture?.input_modalities ?? [],
        tokenizer: m.architecture?.tokenizer ?? null,
        supportedParameters: m.supported_parameters ?? [],
        reasoning: m.reasoning ?? null,
        expirationDate: m.expiration_date ?? null,
    }))

if (asJson) {
    console.log(JSON.stringify({ registryProfiles: profiles.length, days, candidates }, null, 2))
} else {
    console.log(`registry profiles: ${profiles.length}; OpenRouter models from tracked vendors created in the last ${days} days without an openrouter profile: ${candidates.length}`)
    for (const c of candidates) {
        console.log(`${c.created}  ${c.id}  ctx=${c.contextLength} out=${c.maxOutputTokens} tok=${c.tokenizer}`)
    }
}
