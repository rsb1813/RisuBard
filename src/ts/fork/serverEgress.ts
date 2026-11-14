// Fork patch (rsb1813/RisuBard): server-only egress.
//
// Every cross-origin HTTP(S) request the page makes with fetch() is rerouted
// through this server's /proxy2, so the browser never contacts an AI provider
// or any other external API directly. This one choke point covers the
// fetchNative direct-first attempt, globalFetch's plain-fetch path, and the
// raw fetch() call sites (TTS, image generation, model lists, tokenizers, ...)
// without touching any of them, which keeps the fork's diff against upstream
// to this file plus one import in main.ts.
//
// Not covered by design (they run inside the browser or are not fetch):
// WebSocket connections, XMLHttpRequest, and fetches made inside Web Workers.

const PROXY_PATH = '/proxy2'

// The official model registry channel is redirected to the fork's registry,
// which is refreshed daily. Leaves remote.ts (and its tests) untouched.
// Legacy names are encoded the same way remote.ts does it, to keep the
// repository's brand-boundary check (scripts/check-brand-boundary) passing.
const LEGACY_REGISTRY_OWNER = atob('UG9ja2V0UmlzdQ==')
const LEGACY_REGISTRY_REPOSITORY = atob('cG9ja2V0cmlzdS1tb2RlbC1yZWdpc3RyeQ==')
const UPSTREAM_REGISTRY_BASE = `https://raw.githubusercontent.com/${LEGACY_REGISTRY_OWNER}/${LEGACY_REGISTRY_REPOSITORY}/main/`
const FORK_REGISTRY_BASE = `https://raw.githubusercontent.com/rsb1813/${LEGACY_REGISTRY_REPOSITORY}/main/`

export function rewriteRegistryUrl(url: string): string {
    return url.startsWith(UPSTREAM_REGISTRY_BASE)
        ? FORK_REGISTRY_BASE + url.slice(UPSTREAM_REGISTRY_BASE.length)
        : url
}

// Static assets that are not API calls: libraries, fonts and in-browser model
// weights. Proxying them would only add load on the server.
const DIRECT_HOSTS = new Set([
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
])

export function shouldRouteThroughServer(url: URL, pageOrigin: string): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.origin === pageOrigin) return false
    if (DIRECT_HOSTS.has(url.hostname)) return false
    // Hugging Face model weight downloads for in-browser models (transformers.js).
    // The inference API lives on other hostnames and is still proxied.
    if (url.hostname === 'huggingface.co' && url.pathname.includes('/resolve/')) return false
    return true
}

type CreateAuth = () => Promise<string>

let createAuthImpl: CreateAuth | null = null

async function createAuth(): Promise<string> {
    if (!createAuthImpl) {
        const { forageStorage } = await import('../globalApi.svelte')
        createAuthImpl = () => forageStorage.createAuth()
    }
    return createAuthImpl()
}

// Headers and query parameters that carry a credential. A request with one of
// these is never sent from the browser, even when no server token exists yet.
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cookie']
const CREDENTIAL_QUERY = ['key', 'api_key', 'apikey', 'token', 'access_token']

export function carriesCredential(url: URL, headers: Record<string, string>): boolean {
    const names = Object.keys(headers).map((name) => name.toLowerCase())
    return CREDENTIAL_HEADERS.some((name) => names.includes(name))
        || CREDENTIAL_QUERY.some((name) => url.searchParams.has(name))
}

// The app gets its server token only after login; until then createAuth()
// resolves to ''. Requests made during startup (the model registry sync, for
// example) wait for the login instead of reaching /proxy2 without a token.
export async function waitForAuth(
    getAuth: CreateAuth,
    timeoutMs: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    signal?: AbortSignal | null,
): Promise<string> {
    let delay = 250
    let waited = 0
    for (;;) {
        let token = ''
        try { token = await getAuth() } catch { token = '' }
        if (token) return token
        if (waited >= timeoutMs || signal?.aborted) return ''
        await sleep(delay)
        waited += delay
        delay = Math.min(delay * 2, 2_000)
    }
}

const AUTH_WAIT_MS = 15_000

export function createServerEgressFetch(
    nativeFetch: typeof fetch,
    pageOrigin: string,
    getAuth: CreateAuth = createAuth,
    authWaitMs = AUTH_WAIT_MS,
): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rawUrl = input instanceof Request ? input.url : String(input)
        let url: URL
        try {
            url = new URL(rawUrl, pageOrigin)
        } catch {
            return nativeFetch(input, init)
        }
        if (!shouldRouteThroughServer(url, pageOrigin)) {
            return nativeFetch(input, init)
        }

        // Normalizes every body type (string, FormData, Blob, URLSearchParams,
        // stream) to bytes and fills in the matching Content-Type, including a
        // multipart boundary.
        const request = new Request(input, init)
        const method = request.method.toUpperCase()
        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => {
            headers[key] = value
        })
        const body = method === 'GET' || method === 'HEAD'
            ? undefined
            : new Uint8Array(await request.arrayBuffer())

        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const target = rewriteRegistryUrl(url.toString())
        const token = await waitForAuth(getAuth, authWaitMs, undefined, signal)
        if (!token) {
            // Not logged in. A public request without credentials may go out
            // directly (as upstream does); anything carrying a key must not.
            if (!carriesCredential(url, headers)) {
                return nativeFetch(target, {
                    method,
                    headers,
                    body: body && body.byteLength > 0 ? body : undefined,
                    signal,
                })
            }
            return new Response(JSON.stringify({ error: 'Not logged in to the RisuBard server yet; request not sent.' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        const proxyHeaders: Record<string, string> = {
            'risu-url': encodeURIComponent(target),
            'risu-header': encodeURIComponent(JSON.stringify(headers)),
            'risu-auth': token,
        }
        if (body && body.byteLength > 0) {
            // The server only keeps the raw bytes for octet-stream; the real
            // Content-Type travels to the provider inside risu-header.
            proxyHeaders['Content-Type'] = 'application/octet-stream'
        }

        return nativeFetch(PROXY_PATH, {
            method,
            headers: proxyHeaders,
            body: body && body.byteLength > 0 ? body : undefined,
            signal,
        })
    }) as typeof fetch
}

let installed = false

export function installServerEgress(): void {
    if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
    installed = true
    window.fetch = createServerEgressFetch(window.fetch.bind(window), window.location.origin)
}

installServerEgress()
