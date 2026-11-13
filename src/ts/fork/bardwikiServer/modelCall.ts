// Fork patch (rsb1813/RisuBard): server-side model calls for BardWiki analysis.
//
// The browser resolves which model preset and credential the 'memory' and
// 'model' roles use for a chat (the same binding requestChatDataMain uses)
// and hands them to the server with the analysis job. This module performs
// the call on the server with the same adapters the browser uses, so the
// analysis keeps running after the tab is closed.

import type { ModelPreset } from '../../preset/types'
import type { AdapterChatOptions, AdapterChatResponse, AdapterCredential } from '../../preset/adapter'
import { sendAnthropicChatRequest, sendChatRequest, sendGoogleChatRequest } from '../../preset/adapter'
import { formatReasoningParts } from '../../preset/adapter/reasoning'
import { sendWithStructuredOutputFallback } from '../../process/request/structuredOutputFallback'
import { preparePresetResponse, presetGenerationOverrides } from '../../process/request/presetResponse'

// BardWiki schemas are JSON strings (memoryDeltaSchema, memoryWriterDraftSchema,
// ...). The browser's convertInterfaceToSchema only adds TypeScript-interface
// parsing on top of JSON.parse, and pulls in the whole chat parser.
function parseResponseSchema(schema: string): unknown {
    return JSON.parse(schema)
}
import type {
    MemoryAnalysisModelCall,
    MemoryAnalysisModelResponse,
} from '../../risubard/memoryAnalysisClient'

export type ServerModelMode = 'memory' | 'model'

/** What the browser resolved for one model role of a chat. */
export type ServerModelTarget =
    | { kind: 'preset'; preset: ModelPreset; credential?: AdapterCredential }
    | { kind: 'block'; reason: 'main-unset' | 'sub-unset' }

export type ServerModelTargets = Partial<Record<ServerModelMode, ServerModelTarget>>

const SUPPORTED_ADAPTERS = new Set(['openai-compatible', 'anthropic-messages', 'google-gemini'])

/** True when every role the analysis may use can be called from the server. */
export function serverModelTargetsSupported(targets: ServerModelTargets): boolean {
    const entries = Object.values(targets)
    if (entries.length === 0) return false
    return entries.every((target) => target?.kind === 'block'
        || (target?.kind === 'preset'
            && SUPPORTED_ADAPTERS.has(target.preset.profileSnapshot.adapterKind)))
}

function sendModelPreset(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
): Promise<AdapterChatResponse> {
    switch (preset.profileSnapshot.adapterKind) {
        case 'openai-compatible': return sendChatRequest(preset, options, credential)
        case 'anthropic-messages': return sendAnthropicChatRequest(preset, options, credential)
        case 'google-gemini': return sendGoogleChatRequest(preset, options, credential)
        default: throw new Error(`Unsupported adapter for server-side BardWiki: ${String(preset.profileSnapshot.adapterKind)}`)
    }
}

// Mirrors the role normalization requestModelPreset applies for analysis
// calls (one system + one user message): only literal-role adapters may fold
// the system prompt into the user turn.
function toAdapterMessages(call: MemoryAnalysisModelCall, preset: ModelPreset): AdapterChatOptions['messages'] {
    const messages = call.formated.map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
    }))
    const fold = preset.profileSnapshot.adapterKind === 'openai-compatible' && preset.foldSystemPrompt === true
    if (!fold) return messages
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = messages.filter((m) => m.role !== 'system')
    if (!system) return rest
    if (rest[0]?.role === 'user') {
        return [{ role: 'user', content: `${system}\n\n${rest[0].content}` }, ...rest.slice(1)]
    }
    return [{ role: 'user', content: system }, ...rest]
}

export function createServerModelRequester(
    targets: ServerModelTargets,
    fetchImpl: typeof fetch,
) {
    return async function requestModel(
        call: MemoryAnalysisModelCall,
        mode: ServerModelMode,
        signal?: AbortSignal,
    ): Promise<MemoryAnalysisModelResponse> {
        const target = targets[mode]
        if (!target || target.kind === 'block') {
            const reason = target?.kind === 'block'
                ? target.reason
                : (mode === 'model' ? 'main-unset' : 'sub-unset')
            return {
                type: 'fail',
                noRetry: true,
                bindingFailure: reason,
                result: `No model preset bound for ${mode}`,
            } as MemoryAnalysisModelResponse
        }
        const { preset, credential } = target
        const model = preset.profileSnapshot.modelId || preset.id
        const options: AdapterChatOptions = {
            messages: toAdapterMessages(call, preset),
            abortSignal: signal,
            fetchImpl,
            generationId: `bardwiki-server-${Date.now().toString(36)}`,
            ...presetGenerationOverrides(call),
            responseSchema: call.schema ? parseResponseSchema(call.schema) as AdapterChatOptions['responseSchema'] : undefined,
        }
        try {
            const response = await sendWithStructuredOutputFallback(
                options,
                (fallbackOptions) => sendModelPreset(preset, fallbackOptions, credential),
            )
            return preparePresetResponse(response, {
                internal: true,
                model,
                formatReasoning: formatReasoningParts,
            }) as MemoryAnalysisModelResponse
        } catch (error) {
            if (signal?.aborted) throw error
            return {
                type: 'fail',
                result: error instanceof Error ? error.message : String(error),
                model,
            } as MemoryAnalysisModelResponse
        }
    }
}
