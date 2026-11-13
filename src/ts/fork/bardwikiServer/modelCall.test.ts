import { describe, expect, it, vi } from 'vitest'
import { createServerModelRequester, serverModelTargetsSupported } from './modelCall'
import type { ModelPreset } from '../../preset/types'

function preset(adapterKind = 'openai-compatible', fold = false): ModelPreset {
    return {
        id: 'p1',
        name: 'Test',
        userValues: {},
        createdAt: 1,
        updatedAt: 1,
        foldSystemPrompt: fold,
        profileSnapshot: {
            profileId: 'demo:standard', profileVersion: 1, providerBaseId: 'demo', providerBaseVersion: 1,
            adapterKind,
            auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
            modelId: 'demo-fast',
            schema: [
                { key: 'apiKey', type: 'string', label: 'API Key', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } },
                { key: 'modelId', type: 'string', label: 'Model ID', default: 'demo-fast', mapsTo: { target: 'body', path: 'model' } },
            ],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
            headerTemplate: { 'Content-Type': 'application/json' },
            capabilities: ['streaming'],
        },
    } as unknown as ModelPreset
}

const call = {
    formated: [
        { role: 'system', content: 'Return JSON.' },
        { role: 'user', content: 'Alice met Bob.' },
    ],
    useStreaming: false,
    noMultiGen: true,
    tools: [],
    maxTokens: 2048,
    temperature: 0,
    bias: {},
    extractJson: '',
    logSource: 'memory',
    schema: JSON.stringify({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }),
} as never

describe('server-side BardWiki model calls', () => {
    it('accepts only adapter kinds the server can call', () => {
        expect(serverModelTargetsSupported({})).toBe(false)
        expect(serverModelTargetsSupported({ memory: { kind: 'preset', preset: preset() } })).toBe(true)
        expect(serverModelTargetsSupported({
            memory: { kind: 'block', reason: 'sub-unset' },
            model: { kind: 'preset', preset: preset('anthropic-messages') },
        })).toBe(true)
        expect(serverModelTargetsSupported({ memory: { kind: 'preset', preset: preset('plugin-thing') } })).toBe(false)
    })

    it('reports an unbound memory role as sub-unset so the runner retries with the main model', async () => {
        const request = createServerModelRequester({ memory: { kind: 'block', reason: 'sub-unset' } }, vi.fn() as never)
        await expect(request(call, 'memory')).resolves.toMatchObject({ type: 'fail', bindingFailure: 'sub-unset' })
    })

    it('calls the provider with the key and the response schema', async () => {
        const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"title":"Meeting"}' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        const request = createServerModelRequester(
            { model: { kind: 'preset', preset: preset('openai-compatible', true), credential: { apiKey: 'sk-test' } } },
            fetchImpl as unknown as typeof fetch,
        )
        const response = await request(call, 'model')

        expect(response).toMatchObject({ type: 'success', result: '{"title":"Meeting"}' })
        const [url, init] = fetchImpl.mock.calls[0]
        expect(url).toBe('https://demo.test/v1/chat/completions')
        const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
        expect(headers.authorization).toBe('Bearer sk-test')
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe('demo-fast')
        expect(body.response_format).toBeDefined()
        // foldSystemPrompt folds the system prompt into the first user turn.
        expect(body.messages).toEqual([{ role: 'user', content: 'Return JSON.\n\nAlice met Bob.' }])
    })

    it('turns transport errors into a failed response instead of throwing', async () => {
        const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
        const request = createServerModelRequester(
            { model: { kind: 'preset', preset: preset(), credential: { apiKey: 'sk' } } },
            fetchImpl as unknown as typeof fetch,
        )
        await expect(request(call, 'model')).resolves.toMatchObject({ type: 'fail' })
    })
})
