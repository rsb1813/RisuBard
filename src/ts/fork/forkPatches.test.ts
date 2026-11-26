import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards for fork patches that live inside upstream Svelte components, where a
// behaviour test would need the whole chat screen. An upstream merge that drops
// or rewrites the patched line fails here instead of shipping silently.
const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8')

describe('fork patches in upstream files', () => {
    it('auto translation skips user messages in ChatBody', () => {
        const source = read('src/lib/ChatScreens/ChatBody.svelte')
        expect(source).toContain("if(DBState.db.autoTranslate && DBState.db.translator && role !== 'user'){")
    })
})
