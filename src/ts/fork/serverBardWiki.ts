// Fork patch (rsb1813/RisuBard): server-driven BardWiki analysis.
//
// Drop-in replacement for createStoredResponseMemoryAnalysis. confirm() hands
// the analysis to the server (/api/fork/bardwiki/jobs), which runs the same
// analysis code with server-side model calls, so it finishes even if this tab
// is closed. The browser only waits for the result to refresh the UI.
//
// Falls back to the original in-browser analysis when the chat's 'memory' or
// 'model' role is not a model preset the server can call (legacy providers,
// plugins), or when the server does not offer the route.

import {
    createStoredResponseMemoryAnalysis,
    type MemoryAnalysisInput,
} from '../risubard/memoryAnalysisClient'
import { announceRisuBardMemoryUpdated } from '../risubard/memoryEvents'
import { getCurrentChat, getDatabase } from '../storage/database.svelte'
import {
    applyPromptPresetParams,
    buildModelPresetCredential,
    resolveChatModelBinding,
    resolveRequestModelBindingTarget,
} from '../process/request/modelPresetBinding'
import {
    serverModelTargetsSupported,
    type ServerModelMode,
    type ServerModelTargets,
} from './bardwikiServer/modelCall'

type AnalysisOptions = Parameters<typeof createStoredResponseMemoryAnalysis>[0]
type Analysis = ReturnType<typeof createStoredResponseMemoryAnalysis>
type Receipt = Awaited<ReturnType<Analysis['confirm']>>

export const BARDWIKI_JOBS_PATH = '/api/fork/bardwiki/jobs'
const POLL_INTERVAL_MS = 1_500

export interface ServerBardWikiJobRequest {
    input: MemoryAnalysisInput
    targets: ServerModelTargets
    settings: {
        modelMode?: 'memory' | 'model'
        inquiryTimeoutMs?: number
        analysisOutputTokenLimit?: number
    }
}

export interface ServerBardWikiJobStatus {
    id: string
    status: 'running' | 'done' | 'failed' | 'cancelled'
    receipt?: Receipt
    error?: string
}

/** Resolves the model preset + credential for each role, as requestChatDataMain does. */
export function resolveServerModelTargets(chatId: string): ServerModelTargets {
    const db = getDatabase()
    const chat = resolveRequestModelBindingTarget(undefined, chatId, getCurrentChat())
    const targets: ServerModelTargets = {}
    for (const mode of ['memory', 'model'] as ServerModelMode[]) {
        const binding = resolveChatModelBinding(chat, mode, undefined)
        if (binding.kind === 'modelPreset') {
            const preset = applyPromptPresetParams(binding.preset, chat, mode, db)
            targets[mode] = { kind: 'preset', preset, credential: buildModelPresetCredential(preset) }
        } else if (binding.kind === 'block') {
            targets[mode] = { kind: 'block', reason: binding.reason }
        } else {
            // Legacy provider or plugin: only the browser can call it.
            return {}
        }
    }
    return targets
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
    })
}

export function createStoredResponseMemoryAnalysisWithServer(options: AnalysisOptions): Analysis {
    const local = createStoredResponseMemoryAnalysis(options)

    async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
        return options.fetchImpl(path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'risu-auth': await options.createAuth(),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        })
    }

    async function confirmOnServer(input: MemoryAnalysisInput, signal?: AbortSignal): Promise<Receipt | typeof FALLBACK> {
        const sessionChatId = input.modelSessionChatId ?? input.chatId
        const targets = resolveServerModelTargets(sessionChatId)
        if (!serverModelTargetsSupported(targets)) return FALLBACK

        const request: ServerBardWikiJobRequest = {
            input,
            targets,
            settings: {
                modelMode: options.getModelMode?.(sessionChatId),
                inquiryTimeoutMs: options.getInquiryTimeoutMs?.(sessionChatId),
                analysisOutputTokenLimit: options.getAnalysisOutputTokenLimit?.(sessionChatId),
            },
        }
        let created: Response
        try {
            created = await call('POST', BARDWIKI_JOBS_PATH, request, signal)
        } catch (error) {
            if (signal?.aborted) throw error
            return FALLBACK
        }
        // Older server or the bundle is missing: run in the browser instead.
        if (created.status === 404 || created.status === 503) return FALLBACK
        if (!created.ok) throw new Error(`BardWiki server job failed to start: HTTP ${created.status} ${await created.text()}`)
        const { id } = await created.json() as { id: string }

        try {
            for (;;) {
                await sleep(POLL_INTERVAL_MS, signal)
                const res = await call('GET', `${BARDWIKI_JOBS_PATH}/${encodeURIComponent(id)}`, undefined, signal)
                if (res.status === 404) throw new Error('BardWiki server job was lost (server restarted?)')
                if (!res.ok) continue
                const job = await res.json() as ServerBardWikiJobStatus
                if (job.status === 'running') continue
                if (job.status === 'done') {
                    announceRisuBardMemoryUpdated({ characterId: input.characterId, chatId: input.chatId })
                    return job.receipt
                }
                throw new Error(job.error || `BardWiki server job ${job.status}`)
            }
        } catch (error) {
            // The caller cancelled (e.g. the user stopped the analysis): stop
            // the server job too. A closed tab never gets here, so the job runs on.
            if (signal?.aborted) {
                void call('DELETE', `${BARDWIKI_JOBS_PATH}/${encodeURIComponent(id)}`).catch(() => {})
            }
            throw error
        }
    }

    return {
        ...local,
        async confirm(input: MemoryAnalysisInput, signal?: AbortSignal) {
            if (input.messages.length === 0) return undefined
            const result = await confirmOnServer(input, signal)
            return result === FALLBACK ? local.confirm(input, signal) : result
        },
    }
}

const FALLBACK = Symbol('bardwiki-fallback')
