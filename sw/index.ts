/* Service Worker */
import resources, { resourceInfo, IResourceItem, setResources } from '@/resources'
import { registerRoute } from 'workbox-routing'
import { NetworkFirst, NetworkOnly, CacheFirst } from 'workbox-strategies'

// polyfill promise.any
import 'core-js/features/promise/any'

import testResources from '@/../resources.json'
export function speedTest() {
    // group testresources by tag
    const testResourcesByTag = testResources.reduce(
        (acc, item) => {
            const tag = item.tag
            if (!acc[tag]) {
                acc[tag] = []
            }
            acc[tag].push(item)
            return acc
        },
        {} as Record<string, IResourceItem[]>,
    ) as Record<string, IResourceItem[]>
    // test each tag
    const allPromises = [] as Promise<IResourceItem>[]
    const waitPromises = [] as Promise<IResourceItem>[]
    for (const tag of Object.keys(testResourcesByTag)) {
        const items = testResourcesByTag[tag]
        const promises = items.map((item) =>
            (async () => {
                const ret = await fetch((item.prefix || '') + item.test, {
                    method: 'HEAD',
                    mode: 'cors',
                })
                if (!ret.ok) {
                    throw new Error(`${item.test} is not available`)
                }

                const r1 = { ...item.resources }
                for (const key of Object.keys(r1)) {
                    if (resourceInfo[key]) resourceInfo[key].urls.push((item.prefix || '') + r1[key])
                }
                return item
            })(),
        )
        allPromises.push(
            Promise.any(promises).then((item) => {
                const r1 = { ...item.resources }
                for (const key of Object.keys(r1)) {
                    r1[key] = (item.prefix || '') + r1[key]
                }
                setResources(r1)
                return item
            }),
        )
        waitPromises.push(...promises)
    }
    return [Promise.allSettled(allPromises), Promise.allSettled(waitPromises)]
}

type EntryManifest = [string, string[], string[], string]

const cacheName = 'cocogoat-sw'
const manifestCacheName = cacheName + '-manifest'
const manifestBaseUrl = new URL(process.env.BASE_URL, location.href)
const manifestUrl = new URL('index.json', manifestBaseUrl).toString()
const localManifestUrl = new URL('/_sw/index.json', location.href).toString()
const lastGoodManifestUrl = new URL('/_sw/meta/last-good-index', location.href).toString()

let speedTestResult = [] as Awaited<ReturnType<typeof speedTest>>

function isEntryManifest(value: unknown): value is EntryManifest {
    return (
        Array.isArray(value) &&
        typeof value[0] === 'string' &&
        Array.isArray(value[1]) &&
        value[1].every((item) => typeof item === 'string') &&
        Array.isArray(value[2]) &&
        value[2].every((item) => typeof item === 'string') &&
        typeof value[3] === 'string'
    )
}

function noStoreResponse(response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

async function ensureEntryAssets(manifest: EntryManifest) {
    if (manifest[1].length === 0) {
        throw new Error('Entry manifest has no startup scripts')
    }
    const cache = await caches.open(cacheName)
    const assets = [...manifest[1], ...manifest[2]]
    await Promise.all(
        assets.map(async (asset) => {
            const assetUrl = new URL(asset, manifestBaseUrl).toString()
            const request = new Request(assetUrl)
            const cached = await cache.match(request)
            if (cached && (cached.ok || cached.type === 'opaque')) return

            const response = await fetch(new Request(assetUrl, { cache: 'no-store' }))
            if (!response.ok) {
                throw new Error('Entry asset unavailable: ' + assetUrl + ' (' + response.status + ')')
            }
            if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
                throw new Error('Entry asset returned HTML: ' + assetUrl)
            }
            await cache.put(request, response.clone())
        }),
    )
}

async function getLastGoodManifest(): Promise<Response | null> {
    const cache = await caches.open(manifestCacheName)
    const candidates = [await cache.match(lastGoodManifestUrl), await cache.match(manifestUrl)]
    for (const candidate of candidates) {
        if (!candidate) continue
        try {
            const manifest = await candidate.clone().json()
            if (!isEntryManifest(manifest)) continue
            await ensureEntryAssets(manifest)
            return candidate
        } catch (error) {
            console.warn('[cocogoat-sw] cached entry manifest is unusable:', error)
        }
    }
    return null
}

async function fetchVerifiedManifest(): Promise<Response> {
    try {
        const response = await fetch(new Request(manifestUrl, { cache: 'no-store' }))
        if (!response.ok) {
            throw new Error('Manifest returned ' + response.status)
        }
        const manifest = await response.clone().json()
        if (!isEntryManifest(manifest)) {
            throw new Error('Invalid entry manifest')
        }
        await ensureEntryAssets(manifest)
        const cache = await caches.open(manifestCacheName)
        await cache.put(lastGoodManifestUrl, response.clone())
        return noStoreResponse(response)
    } catch (error) {
        console.warn('[cocogoat-sw] new entry manifest rejected; using last known good:', error)
        const fallback = await getLastGoodManifest()
        if (fallback) return noStoreResponse(fallback)
        return new Response('[cocogoat-sw] No complete entry manifest is available', {
            status: 503,
            headers: { 'Cache-Control': 'no-store' },
        })
    }
}

async function rewriteEntrance(response: Response): Promise<Response> {
    if (!response.ok) {
        throw new Error('Entrance returned ' + response.status)
    }
    const html = await response.text()
    if (html.includes(localManifestUrl)) {
        return new Response(html, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    }
    const match = html.match(/fetch\((['"])([^'"]*index\.json)\1\)/)
    if (!match) {
        // The webpack-generated entrance contains direct hashed startup tags,
        // not the externally deployed dynamic loader. Preserve that format.
        if (/<script\b[^>]*\bsrc\s*=/.test(html)) {
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            })
        }
        throw new Error('Entrance has neither a supported loader nor startup scripts')
    }
    if (html.indexOf(match[0]) !== html.lastIndexOf(match[0])) {
        throw new Error('Entrance contains multiple index.json loader requests')
    }
    const rewritten = html.replace(match[0], 'fetch("' + localManifestUrl + '")')
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.delete('etag')
    headers.set('Cache-Control', 'no-store')
    return new Response(rewritten, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

addEventListener('install', (event: ExtendableEvent) => {
    event.waitUntil(
        (async () => {
            const root = new Request(new URL('/', location.href).toString())
            const cache = await caches.open(cacheName)
            const manifestCache = await caches.open(manifestCacheName)
            const existingRoot = await cache.match(root)
            let existingRootReady = false

            if (existingRoot) {
                try {
                    const migrated = await rewriteEntrance(existingRoot.clone())
                    await cache.put(root, migrated)
                    existingRootReady = true
                } catch (error) {
                    console.warn('[cocogoat-sw] cached entrance migration skipped:', error)
                }
            }

            const existingManifest =
                (await manifestCache.match(lastGoodManifestUrl)) || (await manifestCache.match(manifestUrl))
            if (existingManifest) {
                try {
                    const manifest = await existingManifest.clone().json()
                    if (isEntryManifest(manifest)) {
                        await ensureEntryAssets(manifest)
                        if (!(await manifestCache.match(lastGoodManifestUrl))) {
                            await manifestCache.put(lastGoodManifestUrl, existingManifest.clone())
                        }
                    }
                } catch (error) {
                    console.warn('[cocogoat-sw] previous entry manifest could not be verified:', error)
                }
            }

            try {
                const [shellResponse, manifestResponse] = await Promise.all([
                    fetch(new Request(root, { cache: 'no-store' })),
                    fetch(new Request(manifestUrl, { cache: 'no-store' })),
                ])
                if (!shellResponse.ok) throw new Error('Entrance returned ' + shellResponse.status)
                if (!manifestResponse.ok) throw new Error('Manifest returned ' + manifestResponse.status)
                const manifest = await manifestResponse.clone().json()
                if (!isEntryManifest(manifest)) throw new Error('Invalid entry manifest')
                await ensureEntryAssets(manifest)
                const rewritten = await rewriteEntrance(shellResponse)
                await manifestCache.put(lastGoodManifestUrl, manifestResponse.clone())
                if (!(await manifestCache.match(manifestUrl))) {
                    await manifestCache.put(manifestUrl, manifestResponse.clone())
                }
                await cache.put(root, rewritten)
            } catch (error) {
                const fallbackManifest = await getLastGoodManifest()
                if (!existingRootReady || !fallbackManifest) throw error
                console.warn('[cocogoat-sw] keeping previous complete entrance after install failure:', error)
            }
        })(),
    )
})

addEventListener('activate', () => {
    clients.claim()
})

// cache manifest handler
registerRoute(/\/_sw\/register/, async (): Promise<Response> => {
    try {
        caches
            .open(cacheName + '-manifest')
            .then((cache) => cache.put(new Request('/_sw/meta/registered'), new Response('true')))
        return new Response('[cocogoat-sw] manifest registered')
    } catch (e) {
        return new Response('[cocogoat-sw] manifest register FAILD: ' + (e as Error).message, {
            status: 500,
        })
    }
})

// wasm(s)
registerRoute(/\/_sw\/resources\/(.*?)/, async ({ url, request }): Promise<Response> => {
    const u = new URL(url)
    const basename = u.pathname.split('/').pop() || ''
    // check cache
    const cache = await caches.open(cacheName + '-resources')
    const cached = await cache.match(request)
    if (cached) {
        console.log('[cocogoat-sw] resource cached:', basename)
        return cached
    }
    // fastest-mirror
    if (speedTestResult.length <= 0) {
        console.log('[cocogoat-sw] speedtest started')
        speedTestResult = await speedTest()
    }
    await speedTestResult[0]
    const mirror = resources[basename]
    if (!mirror) {
        // return 404
        console.log('[cocogoat-sw] resource 404:', basename)
        return new Response('[cocogoat-sw]Error: Not Found', { status: 404 })
    }
    // fetch
    const response = await fetch(mirror)
    console.log('[cocogoat-sw] resource fetched:', basename)
    // cache
    await cache.put(request, response.clone())
    // return
    return response
})

// offlinefirst for cache
registerRoute(
    new RegExp(`${process.env.BASE_URL}static/(.*)`),
    new CacheFirst({
        cacheName: cacheName,
    }),
)
;(process.env.VUE_APP_BASE_URL_LIST || '').split(',').forEach((url: string) => {
    registerRoute(
        new RegExp(`${url}(.*)`),
        new CacheFirst({
            cacheName: cacheName,
        }),
    )
})

// Validate the loader manifest before allowing it to select startup JS/CSS.
registerRoute(
    ({ url, request }) =>
        request.method === 'GET' && url.origin === location.origin && url.pathname === '/_sw/index.json',
    async (): Promise<Response> => fetchVerifiedManifest(),
)

// networkfirst for jsons
registerRoute(
    /(.*).json/,
    new NetworkFirst({
        cacheName: cacheName,
    }),
)

// networkfirst for contributed
registerRoute(
    /contributed/,
    new NetworkFirst({
        cacheName: cacheName + '-api',
    }),
)

// networkfirst for api-region
registerRoute(
    /api-region/,
    new NetworkFirst({
        cacheName: cacheName + '-api',
    }),
)

// networkfirst for mihoyo.com
registerRoute(
    ({ url }) => {
        return new URL(url).origin.includes('mihoyo.com')
    },
    new NetworkFirst({
        cacheName: cacheName + '-mihoyo',
    }),
)

// cachefirst for static cdn
registerRoute(
    ({ url }) => {
        return new URL(url).origin.includes('bytecdntp.com')
    },
    new CacheFirst({
        cacheName: cacheName + '-prejs',
    }),
)

// network-only for api
registerRoute(new RegExp(`${process.env.BASE_URL}77/(.*)`), new NetworkOnly())

// networkfirst for pages
registerRoute(
    // eslint-disable-next-line prefer-regex-literals
    ({ url, request }) => {
        // check is GET
        if (request.method !== 'GET') {
            return false
        }
        // check same origin
        if (new URL(url).origin !== location.origin) {
            return false
        }
        return !new URL(url).pathname.includes('.')
    },
    async ({ url }): Promise<Response> => {
        const root = new Request(new URL('/', url).toString())
        try {
            const response = await fetch(new Request(root, { cache: 'no-store' }))
            const rewritten = await rewriteEntrance(response)
            const cache = await caches.open(cacheName)
            await cache.put(root, rewritten.clone())
            return rewritten
        } catch (error) {
            const cache = await caches.open(cacheName)
            const cached = await cache.match(root)
            if (cached) {
                console.warn('[cocogoat-sw] using cached entrance:', error)
                return cached
            }
            return new Response('[cocogoat-sw] Error: You are offline and no cached version installed!', {
                status: 404,
            })
        }
    },
)
