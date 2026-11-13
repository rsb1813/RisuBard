// Fork patch (rsb1813/RisuBard): server-driven BardWiki analysis jobs.
//
// POST   /api/fork/bardwiki/jobs      start: { input, targets, settings } -> { id }
// GET    /api/fork/bardwiki/jobs/:id  status: { id, status, receipt?, error? }
// DELETE /api/fork/bardwiki/jobs/:id  cancel
//
// The analysis code is the browser's own (src/ts/risubard/memoryAnalysisClient.ts),
// bundled for Node into ./dist/bardwiki-runner.cjs by
// fork/vite.bardwiki-server.config.ts. It talks to this server's memory API
// over loopback and calls the model with the preset and credential the browser
// resolved, so a job finishes even after the tab that started it is closed.
// Jobs and credentials live in memory only; a server restart drops running jobs.
'use strict'

const path = require('node:path')
const crypto = require('node:crypto')

const RUNNER_PATH = path.join(__dirname, 'dist', 'bardwiki-runner.cjs')
const JOB_TTL_MS = 60 * 60 * 1000
const MAX_FINISHED_JOBS = 200

function loadRunner(logger) {
    try {
        return require(RUNNER_PATH)
    } catch (error) {
        logger?.warn?.(`[BardWiki server] runner bundle unavailable, browser analysis stays in use: ${error?.message ?? error}`)
        return null
    }
}

function createBardWikiJobs({ auth, createAuth, logger, loadRunnerImpl = loadRunner }) {
    let runner
    const getRunner = () => (runner === undefined ? (runner = loadRunnerImpl(logger)) : runner)
    const jobs = new Map()
    // One analysis at a time per chat, in arrival order, as in the browser.
    const chatQueues = new Map()

    function prune() {
        const now = Date.now()
        const finished = [...jobs.values()].filter((job) => job.status !== 'running')
        for (const job of finished) {
            if (now - job.finishedAt > JOB_TTL_MS) jobs.delete(job.id)
        }
        const excess = finished.length - MAX_FINISHED_JOBS
        if (excess > 0) {
            finished.sort((a, b) => a.finishedAt - b.finishedAt)
                .slice(0, excess).forEach((job) => jobs.delete(job.id))
        }
    }

    function publicJob(job) {
        return { id: job.id, status: job.status, receipt: job.receipt, error: job.error }
    }

    async function runJob(job, request, baseUrl) {
        const bundle = getRunner()
        bundle.setBardWikiNodeContext({ baseUrl, createAuth })
        const settings = request.settings ?? {}
        const analysis = bundle.createStoredResponseMemoryAnalysis({
            requestModel: bundle.createServerModelRequester(request.targets, bundle.selfFetch),
            fetchImpl: bundle.selfFetch,
            createAuth,
            getModelMode: () => settings.modelMode,
            getInquiryTimeoutMs: () => settings.inquiryTimeoutMs,
            getAnalysisOutputTokenLimit: () => settings.analysisOutputTokenLimit,
            onError(error) {
                logger?.warn?.(`[BardWiki server] ${error?.message ?? error}`)
            },
            nativeV2Analysis: true,
        })
        return analysis.confirm(request.input, job.controller.signal)
    }

    function start(request, baseUrl) {
        const id = crypto.randomUUID()
        const chatKey = `${request.input.characterId}\u0000${request.input.chatId}`
        const job = {
            id,
            status: 'running',
            controller: new AbortController(),
            startedAt: Date.now(),
            finishedAt: 0,
        }
        jobs.set(id, job)
        const previous = chatQueues.get(chatKey) ?? Promise.resolve()
        const current = previous.catch(() => {}).then(async () => {
            if (job.controller.signal.aborted) throw job.controller.signal.reason ?? new Error('cancelled')
            return runJob(job, request, baseUrl)
        })
        chatQueues.set(chatKey, current)
        current.then(
            (receipt) => {
                job.status = 'done'
                job.receipt = receipt
            },
            (error) => {
                job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
                job.error = String(error?.message ?? error).slice(0, 2048)
                if (job.status === 'failed') logger?.warn?.(`[BardWiki server] job ${id} failed: ${job.error}`)
            },
        ).finally(() => {
            job.finishedAt = Date.now()
            if (chatQueues.get(chatKey) === current) chatQueues.delete(chatKey)
            prune()
        })
        return job
    }

    function isValidRequest(body) {
        return body && typeof body === 'object'
            && body.input && typeof body.input.characterId === 'string'
            && typeof body.input.chatId === 'string'
            && Array.isArray(body.input.messages)
            && body.targets && typeof body.targets === 'object'
    }

    function registerRoutes(app) {
        app.post('/api/fork/bardwiki/jobs', async (req, res) => {
            if (!await auth(req, res)) return
            const bundle = getRunner()
            if (!bundle) return res.status(503).json({ error: 'BardWiki server runner unavailable' })
            if (!isValidRequest(req.body)) return res.status(400).json({ error: 'Invalid BardWiki job' })
            if (!bundle.serverModelTargetsSupported(req.body.targets)) {
                return res.status(503).json({ error: 'Model bindings not callable from the server' })
            }
            const port = req.socket.localPort
            const job = start(req.body, `http://127.0.0.1:${port}`)
            res.status(202).json({ id: job.id })
        })

        app.get('/api/fork/bardwiki/jobs/:id', async (req, res) => {
            if (!await auth(req, res)) return
            const job = jobs.get(req.params.id)
            if (!job) return res.status(404).json({ error: 'Unknown job' })
            res.json(publicJob(job))
        })

        app.delete('/api/fork/bardwiki/jobs/:id', async (req, res) => {
            if (!await auth(req, res)) return
            const job = jobs.get(req.params.id)
            if (!job) return res.status(404).json({ error: 'Unknown job' })
            job.controller.abort(new Error('cancelled'))
            res.json(publicJob(job))
        })
    }

    return { registerRoutes, start, jobs }
}

module.exports = { createBardWikiJobs }
