import { beforeEach, describe, expect, it, vi } from 'vitest'

const localConfirm = vi.fn()
const announce = vi.fn()
const binding = vi.fn()

vi.mock('../risubard/memoryAnalysisClient', () => ({
    createStoredResponseMemoryAnalysis: () => ({
        confirm: localConfirm,
        run: vi.fn(),
        prepareContext: vi.fn(),
        schedule: vi.fn(),
    }),
}))
vi.mock('../risubard/memoryEvents', () => ({ announceRisuBardMemoryUpdated: announce }))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => ({}),
    getCurrentChat: () => ({ id: 'chat1' }),
}))
vi.mock('../process/request/modelPresetBinding', () => ({
    resolveRequestModelBindingTarget: (_t: unknown, _id: string, current: unknown) => current,
    resolveChatModelBinding: (_chat: unknown, mode: string) => binding(mode),
    applyPromptPresetParams: (preset: unknown) => preset,
    buildModelPresetCredential: () => ({ apiKey: 'sk' }),
}))

const { createStoredResponseMemoryAnalysisWithServer, resolveServerModelTargets } = await import('./serverBardWiki')

const preset = { id: 'p', profileSnapshot: { adapterKind: 'openai-compatible' } }
const input = {
    characterId: 'c1',
    chatId: 'chat1',
    messages: [{ messageId: 'm1', role: 'user' as const, content: 'hi' }],
}

function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeAnalysis(responses: Array<Response | Error>) {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined })
        const next = responses.shift()
        if (!next) throw new Error('unexpected fetch')
        if (next instanceof Error) throw next
        return next
    }) as unknown as typeof fetch
    const analysis = createStoredResponseMemoryAnalysisWithServer({
        requestModel: vi.fn(),
        fetchImpl,
        createAuth: async () => 'token',
        getModelMode: () => 'memory',
        getInquiryTimeoutMs: () => 1234,
        getAnalysisOutputTokenLimit: () => 4096,
        nativeV2Analysis: true,
    } as never)
    return { analysis, calls }
}

describe('server-driven BardWiki (client side)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        localConfirm.mockReset().mockResolvedValue('local-receipt')
        announce.mockReset()
        binding.mockReset().mockReturnValue({ kind: 'modelPreset', preset })
    })

    it('resolves presets and credentials for both roles', () => {
        binding.mockImplementation((mode: string) => mode === 'memory'
            ? { kind: 'block', reason: 'sub-unset' }
            : { kind: 'modelPreset', preset })
        expect(resolveServerModelTargets('chat1')).toEqual({
            memory: { kind: 'block', reason: 'sub-unset' },
            model: { kind: 'preset', preset, credential: { apiKey: 'sk' } },
        })
    })

    it('stays in the browser for legacy (classic) model settings', async () => {
        binding.mockReturnValue({ kind: 'classic' })
        const { analysis, calls } = makeAnalysis([])
        await expect(analysis.confirm(input as never)).resolves.toBe('local-receipt')
        expect(calls).toHaveLength(0)
    })

    it('falls back to the browser when the server has no BardWiki route', async () => {
        const { analysis } = makeAnalysis([json(404, {})])
        await expect(analysis.confirm(input as never)).resolves.toBe('local-receipt')
    })

    it('runs on the server, polls until done and announces the update', async () => {
        const { analysis, calls } = makeAnalysis([
            json(202, { id: 'job1' }),
            json(200, { id: 'job1', status: 'running' }),
            json(200, { id: 'job1', status: 'done', receipt: { eventIds: ['e1'] } }),
        ])
        const result = analysis.confirm(input as never)
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(result).resolves.toEqual({ eventIds: ['e1'] })
        expect(localConfirm).not.toHaveBeenCalled()
        expect(calls[0]).toMatchObject({ url: '/api/fork/bardwiki/jobs', method: 'POST' })
        expect(calls[0].body).toMatchObject({
            input,
            targets: { memory: { kind: 'preset' }, model: { kind: 'preset' } },
            settings: { modelMode: 'memory', inquiryTimeoutMs: 1234, analysisOutputTokenLimit: 4096 },
        })
        expect(calls[2].url).toBe('/api/fork/bardwiki/jobs/job1')
        expect(announce).toHaveBeenCalledWith({ characterId: 'c1', chatId: 'chat1' })
    })

    it('surfaces a server-side failure as an error', async () => {
        const { analysis } = makeAnalysis([
            json(202, { id: 'job1' }),
            json(200, { id: 'job1', status: 'failed', error: 'invalid model output' }),
        ])
        const result = analysis.confirm(input as never)
        const assertion = expect(result).rejects.toThrow('invalid model output')
        await vi.advanceTimersByTimeAsync(2_000)
        await assertion
    })

    it('cancels the server job when the caller aborts', async () => {
        const { analysis, calls } = makeAnalysis([
            json(202, { id: 'job1' }),
            json(200, { id: 'job1', status: 'cancelled' }),
        ])
        const controller = new AbortController()
        const result = analysis.confirm(input as never, controller.signal)
        const assertion = expect(result).rejects.toBeDefined()
        await vi.advanceTimersByTimeAsync(100)
        controller.abort()
        await vi.advanceTimersByTimeAsync(100)
        await assertion
        expect(calls.at(-1)).toMatchObject({ url: '/api/fork/bardwiki/jobs/job1', method: 'DELETE' })
    })
})
