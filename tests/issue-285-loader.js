const http = require('http')
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { chromium } = require('playwright')

const root = path.resolve('dist')
const old = process.env.COCO_OLD_DIST
const loaderPath = process.env.COCO_LOADER_HTML
if (!old || !loaderPath) throw Error('Set COCO_OLD_DIST and COCO_LOADER_HTML')
const loader = fs
    .readFileSync(loaderPath, 'utf8')
    .replaceAll('https://gi.cocogoat.cn/index.json', 'http://localhost:18765/index.json')
const entry = JSON.parse(fs.readFileSync(path.join(root, 'index.json')))
const newApp = new URL(
    entry[1].find((url) => /\/app\.[^/]+\.js/.test(url)),
    'http://localhost:18765',
).pathname
let release = 'old'
let failNewApp = true
let faultHits = 0
const manifestStatuses = []
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:18765').pathname
    if (url === '/' || url.startsWith('/achievement')) {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        return res.end(loader)
    }
    if (release === 'new' && failNewApp && url === newApp) {
        faultHits++
        res.writeHead(404)
        return res.end('missing asset')
    }
    let file =
        url === '/static/sw.js' ? path.join(root, 'static/sw.js') : path.join(release === 'old' ? old : root, url)
    if (!fs.existsSync(file)) file = path.join(old, url)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404)
        return res.end()
    }
    const type =
        { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' }[
            path.extname(file)
        ] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' })
    fs.createReadStream(file).pipe(res)
})
;(async () => {
    await new Promise((resolve) => {
        server.listen(18765, '127.0.0.1', resolve)
    })
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox'],
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('response', (response) => {
        if (response.url().includes('/_sw/index.json')) manifestStatuses.push(response.status())
    })
    try {
        await page.goto('http://localhost:18765/achievement')
        await page.locator('.count').waitFor({ timeout: 30000 })
        assert.match(await page.locator('.count').first().innerText(), /1854/)
        await page.evaluate(() => navigator.serviceWorker.ready)
        await page.waitForFunction(() => navigator.serviceWorker.controller)
        await page.reload()
        await page.locator('.count').waitFor({ timeout: 30000 })
        assert.match(await page.locator('.count').first().innerText(), /1854/)
        release = 'new'
        await page.reload()
        try {
            await page.locator('.count').waitFor({ timeout: 10000 })
        } finally {
            console.log('new application JS 404 requests:', faultHits)
            assert.ok(faultHits > 0, 'fault injection must be reached')
        }
        assert.match(await page.locator('.count').first().innerText(), /1854/)
        assert.ok(manifestStatuses.includes(200), 'loader must use the Service Worker validated manifest endpoint')

        failNewApp = false
        await page.reload()
        await page.locator('.count').waitFor({ timeout: 30000 })
        assert.match(await page.locator('.count').first().innerText(), /1909/)
        console.log('PASS: failed new entry falls back to V1; available V2 is activated on the next load')
    } finally {
        await browser.close()
        server.close()
    }
})().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
