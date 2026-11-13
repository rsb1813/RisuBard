// Fork patch: runtime context for the server-side BardWiki bundle. The server
// sets it once; the browser-module stubs read it.

export interface BardWikiNodeContext {
    /** Base URL of this server's own HTTP API, e.g. http://127.0.0.1:7777 */
    baseUrl: string
    /** Mints a risu-auth token the server accepts. */
    createAuth: () => Promise<string>
}

let context: BardWikiNodeContext | null = null

export function setBardWikiNodeContext(next: BardWikiNodeContext): void {
    context = next
}

export function getBardWikiNodeContext(): BardWikiNodeContext {
    if (!context) throw new Error('BardWiki server context is not initialized')
    return context
}

/** fetch that resolves app-relative URLs ("/api/...") against this server. */
export const selfFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = raw.startsWith('/') ? new URL(raw, getBardWikiNodeContext().baseUrl) : raw
    return fetch(url, init)
}) as typeof fetch
