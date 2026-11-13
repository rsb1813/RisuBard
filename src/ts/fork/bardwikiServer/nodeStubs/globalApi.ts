// Fork patch: Node stand-in for src/ts/globalApi.svelte.ts, used only by the
// server-side BardWiki bundle (fork/vite.bardwiki-server.config.ts).
// Add exports here only when a bundled module needs them; the build fails on
// a missing one.
import { getBardWikiNodeContext } from '../nodeContext'

// googleServiceAccount/token.ts signs through this server's token route.
export const forageStorage = {
    createAuth: () => getBardWikiNodeContext().createAuth(),
}
