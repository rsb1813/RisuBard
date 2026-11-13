import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBardWikiJobs } = require('./bardwiki-jobs.cjs') as {
    createBardWikiJobs: (deps: Record<string, unknown>) => {
        registerRoutes: (app: unknown) => void
        start: (request: unknown, baseUrl: string) => { id: string; status: string }
        jobs: Map<string, { id: string; status: string; receipt?: unknown; error?: string }>
    }
}

type Handler = (req: Record<string, unknown>, res: FakeRes) => Promise<void>

class FakeRes {
    statusCode = 200
    body: unknown
    status(code: number) { this.statusCode = code; return this }
    json(body: unknown) { this.body = body; return this }
}

function fakeApp() {
    const routes = new Map<string, Handler>()
    const app = {
        post: (path: string, h: Handler) => routes.set(`POST ${path}`, h),
        get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
        delete: (path: string, h: Handler) => routes.set(`DELETE ${path}`, h),
    }
    async function call(method: string, path: string, req: Record<string, unknown> = {}) {
        const res = new FakeRes()
        await routes.get(`${method} ${path}`)!({ socket: { localPort: 7777 }, params: {}, ...req }, res)
        return res
    }
    return { app, call }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const request = (chatId = 'chat1') => ({
    input: { characterId: 'c1', chatId, messages: [{ messageId: 'm1', role: 'user', content: 'hi' }] },
    targets: { memory: { kind: 'preset' } },
    settings: { modelMode: 'memory' },
})

function fakeRunner(confirm: (input: unknown, signal: AbortSignal) => Promise<unknown>) {
    const contexts: unknown[] = []
    const options: Record<string, unknown>[] = []
    return {
        contexts,
        options,
        bundle: {
            setBardWikiNodeContext: (ctx: unknown) => contexts.push(ctx),
            selfFetch: vi.fn(),
            serverModelTargetsSupported: (targets: Record<string, unknown>) => Object.keys(targets).length > 0,
            createServerModelRequester: vi.fn(() => vi.fn()),
            createStoredResponseMemoryAnalysis: (opts: Record<string, unknown>) => {
                options.push(opts)
                return { confirm }
            },
        },
    }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('fork BardWiki server jobs', () => {
    it('answers 503 when the runner bundle is missing, so the browser falls back', async () => {
        const jobs = createBardWikiJobs({ auth: async () => true, createAuth: async () => 't', loadRunnerImpl: () => null })
        const { app, call } = fakeApp()
        jobs.registerRoutes(app)
        const res = await call('POST', '/api/fork/bardwiki/jobs', { body: request() })
        expect(res.statusCode).toBe(503)
    })

    it('rejects bindings the server cannot call', async () => {
        const runner = fakeRunner(async () => undefined)
        const jobs = createBardWikiJobs({ auth: async () => true, createAuth: async () => 't', loadRunnerImpl: () => runner.bundle })
        const { app, call } = fakeApp()
        jobs.registerRoutes(app)
        const res = await call('POST', '/api/fork/bardwiki/jobs', { body: { ...request(), targets: {} } })
        expect(res.statusCode).toBe(503)
    })

    it('runs a job to completion and reports the receipt', async () => {
        const runner = fakeRunner(async () => ({ eventIds: ['e1'] }))
        const createAuth = async () => 'server-token'
        const jobs = createBardWikiJobs({ auth: async () => true, createAuth, loadRunnerImpl: () => runner.bundle })
        const { app, call } = fakeApp()
        jobs.registerRoutes(app)

        const created = await call('POST', '/api/fork/bardwiki/jobs', { body: request() })
        expect(created.statusCode).toBe(202)
        const { id } = created.body as { id: string }
        await flush(); await flush()

        const status = await call('GET', '/api/fork/bardwiki/jobs/:id', { params: { id } })
        expect(status.body).toMatchObject({ id, status: 'done', receipt: { eventIds: ['e1'] } })
        expect(runner.contexts[0]).toEqual({ baseUrl: 'http://127.0.0.1:7777', createAuth })
        const opts = runner.options[0] as { getModelMode: () => string; nativeV2Analysis: boolean }
        expect(opts.getModelMode()).toBe('memory')
        expect(opts.nativeV2Analysis).toBe(true)
    })

    it('runs jobs for the same chat one at a time, in order', async () => {
        const first = deferred<unknown>()
        const order: string[] = []
        let calls = 0
        const runner = fakeRunner(async () => {
            const n = ++calls
            order.push(`start${n}`)
            if (n === 1) await first.promise
            order.push(`end${n}`)
            return n
        })
        const jobs = createBardWikiJobs({ auth: async () => true, createAuth: async () => 't', loadRunnerImpl: () => runner.bundle })
        const a = jobs.start(request('same'), 'http://x')
        const b = jobs.start(request('same'), 'http://x')
        await flush(); await flush()
        expect(order).toEqual(['start1'])
        first.resolve(undefined)
        await flush(); await flush(); await flush()
        expect(order).toEqual(['start1', 'end1', 'start2', 'end2'])
        expect(jobs.jobs.get(a.id)?.status).toBe('done')
        expect(jobs.jobs.get(b.id)?.status).toBe('done')
    })

    it('marks failures and cancellations', async () => {
        const runner = fakeRunner(async (_input, signal) => {
            if ((_input as { chatId: string }).chatId === 'bad') throw new Error('model said no')
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
        })
        const jobs = createBardWikiJobs({ auth: async () => true, createAuth: async () => 't', loadRunnerImpl: () => runner.bundle, logger: { warn: vi.fn() } })
        const { app, call } = fakeApp()
        jobs.registerRoutes(app)

        const bad = jobs.start(request('bad'), 'http://x')
        const slow = jobs.start(request('slow'), 'http://x')
        await flush(); await flush()
        await call('DELETE', '/api/fork/bardwiki/jobs/:id', { params: { id: slow.id } })
        await flush(); await flush()

        expect(jobs.jobs.get(bad.id)).toMatchObject({ status: 'failed', error: 'model said no' })
        expect(jobs.jobs.get(slow.id)?.status).toBe('cancelled')
        const missing = await call('GET', '/api/fork/bardwiki/jobs/:id', { params: { id: 'nope' } })
        expect(missing.statusCode).toBe(404)
    })

    it('requires auth on every route', async () => {
        const runner = fakeRunner(async () => undefined)
        const jobs = createBardWikiJobs({ auth: async () => false, createAuth: async () => 't', loadRunnerImpl: () => runner.bundle })
        const { app, call } = fakeApp()
        jobs.registerRoutes(app)
        const res = await call('POST', '/api/fork/bardwiki/jobs', { body: request() })
        expect(res.body).toBeUndefined()
        expect(runner.options).toHaveLength(0)
    })
})
