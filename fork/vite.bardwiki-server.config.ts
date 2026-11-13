// Fork patch: bundles the BardWiki analysis code for the Node server.
// Output: server/node/fork/bardwiki-runner.cjs (gitignored build artifact,
// shipped with the server/ runtime path). Built by fork/build-server.sh.
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const root = resolve(__dirname, '..')

// Browser-only modules (DOM, Svelte app state, the client database) are
// replaced with Node stand-ins in src/ts/fork/bardwikiServer/nodeStubs. A stub
// that lacks an export a bundled module needs fails the build, so an upstream
// change that drags in more browser state is caught here, not at runtime.
const STUBBED = new Map([
    ['src/ts/globalApi.svelte.ts', 'globalApi.ts'],
    ['src/ts/stores.svelte.ts', 'stores.ts'],
    ['src/ts/storage/database.svelte.ts', 'database.ts'],
])

function replaceBrowserModules() {
    const stubDir = resolve(root, 'src/ts/fork/bardwikiServer/nodeStubs')
    return {
        name: 'bardwiki-browser-stubs',
        enforce: 'pre' as const,
        async resolveId(this: { resolve: (s: string, i?: string, o?: object) => Promise<{ id: string } | null> }, source: string, importer: string | undefined) {
            if (!importer || importer.startsWith(stubDir)) return null
            const resolved = await this.resolve(source, importer, { skipSelf: true })
            if (!resolved) return null
            const rel = resolved.id.replaceAll('\\', '/').replace(root.replaceAll('\\', '/') + '/', '')
            const stub = STUBBED.get(rel)
            return stub ? resolve(stubDir, stub) : null
        },
    }
}

// Debug aid: BARDWIKI_TRACE=<substring> prints the import chain from the entry
// to the first module whose id contains the substring.
function traceImportChain(target: string) {
    const graph = new Map<string, readonly string[]>()
    let entry = ''
    return {
        name: 'bardwiki-trace',
        moduleParsed(info: { id: string; importedIds: readonly string[]; dynamicallyImportedIds: readonly string[]; isEntry: boolean }) {
            graph.set(info.id, [...info.importedIds, ...info.dynamicallyImportedIds])
            if (info.isEntry) entry = info.id
        },
        buildEnd() {
            const prev = new Map<string, string>([[entry, '']])
            const queue = [entry]
            while (queue.length > 0) {
                const id = queue.shift()!
                if (id.includes(target)) {
                    const chain: string[] = []
                    for (let cur = id; cur; cur = prev.get(cur)!) chain.unshift(cur.replace(root, ''))
                    console.log(`\n[trace] ${chain.join('\n  -> ')}\n`)
                    return
                }
                for (const next of graph.get(id) ?? []) if (!prev.has(next)) { prev.set(next, id); queue.push(next) }
            }
            console.log(`[trace] no path to ${target}`)
        },
    }
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))
const PROD_DEPS: string[] = Object.keys(pkg.dependencies ?? {})

export default defineConfig({
    root,
    publicDir: false,
    define: {
        '__APP_VERSION__': JSON.stringify(pkg.version),
    },
    plugins: [
        replaceBrowserModules(),
        svelte({ configFile: false }),
        process.env.BARDWIKI_TRACE ? traceImportChain(process.env.BARDWIKI_TRACE) : null,
    ],
    resolve: {
        alias: { src: resolve(root, 'src') },
        conditions: ['node'],
    },
    ssr: {
        // Production dependencies are present in the runtime image (taken from
        // upstream), so they stay external and load from node_modules; only
        // app source and dev-only packages are bundled.
        noExternal: true,
    },
    build: {
        ssr: resolve(root, 'src/ts/fork/bardwikiServer/entry.ts'),
        outDir: resolve(root, 'server/node/fork/dist'),
        emptyOutDir: true,
        target: 'node22',
        minify: false,
        sourcemap: false,
        rollupOptions: {
            external: (id: string) => id.startsWith('node:')
                || PROD_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`)),
            output: {
                format: 'cjs',
                entryFileNames: 'bardwiki-runner.cjs',
                codeSplitting: false,
            },
        },
    },
})
