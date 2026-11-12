import { isEqual, reduce } from 'lodash-es'
export { WorkerUrl } from './corsWorker'

export class ServiceWorker {
    url: string
    fallback = false
    manifest = ''
    additionalCachedUrls = [] as string[]
    additionalResources: Record<string, string> = {}
    justinstall = false
    sw = navigator.serviceWorker ? navigator.serviceWorker.controller : null
    onprogress?: (loaded: number, total: number) => unknown
    custom = {} as Record<string, unknown>
    constructor(
        _url: string | URL,
        {
            fallback,
            manifest,
            additionalCachedUrls,
            additionalResources,
            onprogress,
        }: {
            fallback: string
            manifest: string
            additionalCachedUrls?: string[]
            additionalResources: Record<string, string>
            onprogress?: (loaded: number, total: number) => unknown
        },
    ) {
        const url: URL = new URL(_url, location.href)
        if (url.origin !== location.origin) {
            this.url = fallback.toString()
            this.fallback = true
        } else {
            this.url = url.href
        }
        this.manifest = manifest
        this.additionalCachedUrls = additionalCachedUrls || []
        this.additionalResources = additionalResources
        this.onprogress = onprogress
    }
    async install() {
        // if fallback, check file exists
        if (this.fallback) {
            try {
                const response = await fetch(this.url)
                if (response.status !== 200) {
                    throw new Error(`${response.status} ${response.statusText}`)
                }
            } catch (e) {
                return
            }
        }
        // check support
        if (!('serviceWorker' in navigator)) {
            return
        }
        this.addInstallListener()
        // check if already installed and is the same version
        const current = navigator.serviceWorker.controller
        if (current) {
            if (new URL(this.url, location.href).toString() === current.scriptURL) {
                return this.checkUpdate()
            }
        }
        // register
        navigator.serviceWorker
            .register(this.url, {
                scope: '/',
            })
            .then(async (registration) => {
                // wait for install
                await navigator.serviceWorker.ready
                console.log('[cocogoat-sw] ServiceWorker installed', registration)
                this.justinstall = true
            })
    }

    async uninstall() {
        const r = await navigator.serviceWorker.getRegistrations()
        for (const registration of r) {
            await registration.unregister()
        }
    }

    async addInstallListener() {
        window.addEventListener('appinstalled', async () => {
            console.log('[cocogoat-sw] installed to app')
            await fetch('/_sw/register')
            this.cacheAll(true)
        })
    }
    async checkUpdate() {
        if (window.$cocogoat.pre) return
        if (!this.manifest) return
        const manifestCache = await caches.open('cocogoat-sw-manifest')
        const cachedManifest = await manifestCache.match(__webpack_public_path__ + 'index.json')
        if (!cachedManifest) return
        const cachedJson = await cachedManifest.json()
        const swManifest = cachedJson[3]
        if (this.manifest !== swManifest) {
            console.log('[cocogoat-sw] update found:', this.manifest + ' >> ' + swManifest)
            this.cacheAll()
        } else {
            console.log('[cocogoat-sw] no update found', this.manifest)
        }
    }
    async cacheAll(force = false) {
        if (!navigator.serviceWorker || !this.sw) {
            throw new Error('ServiceWorker not installed')
        }
        if (!this.manifest) {
            throw new Error('Manifest not loaded')
        }
        // fetch manifest
        const publicPath = new URL(__webpack_public_path__, location.href)
        const manifestUrl = new URL(this.manifest, publicPath)
        const manifestReq = await fetch(manifestUrl.toString())
        if (manifestReq.status !== 200) {
            throw new Error(`${manifestReq.status} ${manifestReq.statusText}`)
        }
        const _manifest = (await manifestReq.json()) as string[]
        // Keep content-hashed assets from previous builds. Existing tabs may still
        // request lazy-loaded chunks after a newer manifest has been selected.
        const manifestCache = await caches.open('cocogoat-sw-manifest')
        const cachedResources = await manifestCache.match('/_sw/meta/resources')
        const cachedResourcesJson: typeof this.additionalResources = cachedResources ? await cachedResources.json() : {}
        const changedResources = !isEqual(cachedResourcesJson, this.additionalResources)
        const diffKey = changedResources
            ? reduce(
                  this.additionalResources,
                  function (result, value, key) {
                      return isEqual(value, cachedResourcesJson[key]) ? result : result.concat(key)
                  },
                  [] as string[],
              )
            : []
        const cachedManifest = await manifestCache.match('/_sw/meta/registered')
        if (!cachedManifest && !force) return this.updateCachedManifest()
        const manifest = [
            ..._manifest,
            ...this.additionalCachedUrls,
            ...Object.keys(this.additionalResources).map((e) =>
                new URL('/_sw/resources/' + e, location.href).toString(),
            ),
        ]
        manifest.push(new URL('/', location.href).toString())
        // fetch all files
        let loaded = 0
        const total = manifest.length
        if (this.onprogress) this.onprogress.bind(this)(loaded, total)
        const promises = manifest.map((url) => {
            const urlObj = new URL(url, publicPath)
            return fetch(urlObj.toString(), {
                cache: 'no-store',
            })
                .then((res) => {
                    if (res.status !== 200) {
                        throw new Error(`${res.status} ${res.statusText}`)
                    }
                    return res.blob()
                })
                .then(() => {
                    loaded++
                    if (this.onprogress) this.onprogress.bind(this)(loaded, total)
                    console.log('[cocogoat-sw] precache', loaded + '/' + total)
                })
        })
        await Promise.all(promises)
        await this.updateCachedManifest()
        // Never invalidate the old models or advance their metadata until
        // every requested resource and the entry manifest have succeeded.
        if (changedResources) {
            const resCache = await caches.open('cocogoat-sw-resources')
            for (const name of diffKey) {
                await resCache.delete(new URL('/_sw/resources/' + name, location.href).toString())
            }
            await manifestCache.put('/_sw/meta/resources', new Response(JSON.stringify(this.additionalResources)))
        }
    }
    async updateCachedManifest() {
        const path = __webpack_public_path__ + 'index.json'
        const manifestCache = await caches.open('cocogoat-sw-manifest')
        const indexJson = await fetch('/_sw/index.json', { cache: 'no-store' })
        if (!indexJson.ok) {
            throw new Error(indexJson.status + ' ' + indexJson.statusText)
        }
        await manifestCache.put(path, indexJson.clone())
        await manifestCache.put('/_sw/meta/last-good-index', indexJson)
    }
}
