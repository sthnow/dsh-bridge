import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { gzipSync, gunzipSync } from 'node:zlib'
import { ProxyServer } from '../lib/index.js'

const asset = '/assets/index-AbCd0123.js'
const source = Buffer.from('export const value = 42;\n'.repeat(100))
const etag = 'W/"test-asset"'

function read(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('proxy negotiates compression only for fingerprinted shell assets without changing cache policy', async (t) => {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers['accept-encoding'])
    if (req.url === '/' || req.url === '/assets/index-Fallback.js') {
      const html = '<html><head></head><body>shell</body></html>'
      const headers = { 'content-type': 'text/html', 'cache-control': 'no-cache', vary: 'Accept-Encoding' }
      if (req.headers['accept-encoding'] === 'gzip') headers['content-encoding'] = 'gzip'
      res.writeHead(200, headers)
      res.end(headers['content-encoding'] ? gzipSync(html) : html)
      return
    }
    const headers = {
      'content-type': 'text/javascript',
      'cache-control': req.url === '/assets/index-NoStore0.js' ? 'no-store' : 'no-cache',
      vary: req.url === '/assets/index-Cookie00.js' ? 'Accept-Encoding, Cookie' : 'Accept-Encoding',
      etag,
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    if (req.headers['accept-encoding'] === 'gzip') {
      headers['content-encoding'] = 'gzip'
    }
    res.writeHead(200, headers)
    res.end(headers['content-encoding'] ? gzipSync(source) : source)
  })
  await new Promise((resolve, reject) => upstream.listen(0, '127.0.0.1', resolve).once('error', reject))
  const proxy = new ProxyServer({
    localPort: 0, targetPort: upstream.address().port,
    authManager: { verifyRequest: (req) => ({ authenticated: req.headers.cookie === 'test=allowed' }) },
    logger: { info() {}, warn() {}, error() {} },
  })
  t.after(async () => {
    await proxy.stop()
    await new Promise((resolve) => upstream.close(resolve))
  })
  await proxy.start()
  const port = proxy.server.address().port
  const client = { cookie: 'test=allowed', 'accept-encoding': 'gzip' }

  const denied = await read(port, asset)
  assert.equal(denied.status, 401)
  assert.equal(denied.headers['cache-control'], undefined)
  assert.equal(seen.length, 0)

  const compressed = await read(port, asset, client)
  assert.equal(compressed.status, 200)
  assert.equal(compressed.headers['cache-control'], 'no-cache')
  assert.equal(compressed.headers.etag, etag)
  assert.equal(seen.at(-1), 'gzip')
  assert.equal(compressed.headers['content-encoding'], 'gzip')
  assert.equal(compressed.headers.vary, 'Accept-Encoding')
  assert.deepEqual(gunzipSync(compressed.body), source)
  assert.ok(compressed.body.length < source.length)

  const identity = await read(port, asset, { ...client, 'accept-encoding': 'identity' })
  assert.equal(identity.headers['content-encoding'], undefined)
  assert.deepEqual(identity.body, source)
  const revalidated = await read(port, asset, { ...client, 'if-none-match': compressed.headers.etag })
  assert.equal(revalidated.status, 304)
  assert.equal(revalidated.body.length, 0)
  assert.equal(revalidated.headers['cache-control'], 'no-cache')
  assert.equal(revalidated.headers.etag, etag)
  assert.equal(revalidated.headers.vary, 'Accept-Encoding')

  const range = await read(port, asset, { ...client, range: 'bytes=0-9' })
  assert.equal(seen.at(-1), undefined)
  assert.equal(range.headers['content-encoding'], undefined)

  for (const [path, expected] of [
    ['/assets/index-NoStore0.js', 'no-store'], ['/assets/index-Cookie00.js', 'no-cache'],
    ['/assets/index-Fallback.js', 'no-cache'], [`${asset}?dynamic=1`, 'no-cache'],
    ['/api/data', 'no-cache'], ['/plugin/client.js', 'no-cache'], ['/', 'no-cache'],
  ]) {
    const start = seen.length
    const response = await read(port, path, client)
    assert.equal(response.headers['cache-control'], expected, path)
    if (path === '/assets/index-Fallback.js' || path === '/') {
      assert.equal(response.headers['content-encoding'], undefined)
      assert.equal(Number(response.headers['content-length']), response.body.length)
      assert.match(response.body.toString(), /data-dsh-bridge-polyfill/)
    }
    const negotiation = path === '/assets/index-Fallback.js' ? ['gzip', undefined]
      : path.startsWith('/assets/') && !path.includes('?') ? ['gzip'] : [undefined]
    assert.deepEqual(seen.slice(start), negotiation, path)
  }
})
