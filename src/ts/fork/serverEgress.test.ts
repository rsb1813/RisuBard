import { describe, expect, it, vi } from 'vitest'
import { createServerEgressFetch, shouldRouteThroughServer } from './serverEgress'

const ORIGIN = 'http://192.168.0.50:7777'

function recordingFetch() {
    const calls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return new Response('ok', { status: 200 })
    })
    return { fn: fn as unknown as typeof fetch, calls }
}

function decodeHeader(init: RequestInit | undefined, name: string): string {
    return decodeURIComponent((init?.headers as Record<string, string>)[name])
}

// Header names are case-insensitive; browsers lowercase them, happy-dom does not.
function forwardedHeaders(init: RequestInit | undefined): Record<string, string> {
    const parsed = JSON.parse(decodeHeader(init, 'risu-header')) as Record<string, string>
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), v]))
}

describe('shouldRouteThroughServer', () => {
    it('routes external API hosts through the server', () => {
        expect(shouldRouteThroughServer(new URL('https://api.openai.com/v1/chat/completions'), ORIGIN)).toBe(true)
        expect(shouldRouteThroughServer(new URL('https://api.elevenlabs.io/v1/text-to-speech/x'), ORIGIN)).toBe(true)
        expect(shouldRouteThroughServer(new URL('http://192.168.0.9:11434/api/chat'), ORIGIN)).toBe(true)
    })

    it('leaves same-origin, non-http and static asset requests alone', () => {
        expect(shouldRouteThroughServer(new URL('/api/read', ORIGIN), ORIGIN)).toBe(false)
        expect(shouldRouteThroughServer(new URL('blob:http://192.168.0.50:7777/abc'), ORIGIN)).toBe(false)
        expect(shouldRouteThroughServer(new URL('data:text/plain,hi'), ORIGIN)).toBe(false)
        expect(shouldRouteThroughServer(new URL('https://cdn.jsdelivr.net/npm/x'), ORIGIN)).toBe(false)
        expect(shouldRouteThroughServer(new URL('https://huggingface.co/Xenova/m/resolve/main/model.onnx'), ORIGIN)).toBe(false)
        expect(shouldRouteThroughServer(new URL('https://huggingface.co/api/models'), ORIGIN)).toBe(true)
    })
})

describe('createServerEgressFetch', () => {
    it('passes same-origin requests straight through', async () => {
        const { fn, calls } = recordingFetch()
        const egress = createServerEgressFetch(fn, ORIGIN, async () => 'auth')
        await egress('/api/read', { method: 'GET' })
        expect(calls).toHaveLength(1)
        expect(calls[0].input).toBe('/api/read')
    })

    it('sends an external JSON request to /proxy2 as raw bytes with the original headers', async () => {
        const { fn, calls } = recordingFetch()
        const egress = createServerEgressFetch(fn, ORIGIN, async () => 'auth-token')
        const payload = JSON.stringify({ model: 'gpt', messages: [] })
        await egress('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json' },
            body: payload,
        })

        expect(calls).toHaveLength(1)
        const { input, init } = calls[0]
        expect(input).toBe('/proxy2')
        expect(init?.method).toBe('POST')
        expect(decodeHeader(init, 'risu-url')).toBe('https://api.openai.com/v1/chat/completions')
        const forwarded = forwardedHeaders(init)
        expect(forwarded.authorization).toBe('Bearer sk-test')
        expect(forwarded['content-type']).toBe('application/json')
        expect((init?.headers as Record<string, string>)['risu-auth']).toBe('auth-token')
        expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream')
        expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(payload)
    })

    it('keeps the multipart boundary for FormData uploads', async () => {
        const { fn, calls } = recordingFetch()
        const egress = createServerEgressFetch(fn, ORIGIN, async () => 'auth')
        const form = new FormData()
        form.append('model', 'whisper-1')
        await egress('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body: form })

        const forwarded = forwardedHeaders(calls[0].init)
        expect(forwarded['content-type']).toMatch(/^multipart\/form-data; boundary=/)
        const sent = new TextDecoder().decode(calls[0].init?.body as Uint8Array)
        expect(sent).toContain('whisper-1')
    })

    it('redirects the official model registry to the fork registry', async () => {
        const { fn, calls } = recordingFetch()
        const egress = createServerEgressFetch(fn, ORIGIN, async () => 'auth')
        await egress('https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main/index.json')
        expect(decodeHeader(calls[0].init, 'risu-url'))
            .toBe('https://raw.githubusercontent.com/rsb1813/pocketrisu-model-registry/main/index.json')
    })

    it('sends GET requests without a body and forwards the abort signal', async () => {
        const { fn, calls } = recordingFetch()
        const egress = createServerEgressFetch(fn, ORIGIN, async () => 'auth')
        const controller = new AbortController()
        await egress('https://openrouter.ai/api/v1/models', { signal: controller.signal })

        expect(calls[0].input).toBe('/proxy2')
        expect(calls[0].init?.method).toBe('GET')
        expect(calls[0].init?.body).toBeUndefined()
        expect(calls[0].init?.signal).toBe(controller.signal)
    })
})
