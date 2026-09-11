// Pipes a ReadableStream handed over by the page into a same-origin download URL.
// The page keeps all the logic; this worker only answers zipdl/<id>/<name>.

const streams = new Map()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'register') {
    const entry = { name: data.name, size: data.size, stream: null, port: null }
    if (data.stream) {
      entry.stream = data.stream
    } else if (data.port) {
      entry.port = data.port
    }
    streams.set(data.id, entry)
    if (event.ports && event.ports[0] && !data.port) {
      event.ports[0].postMessage({ type: 'registered', id: data.id })
    } else if (event.source) {
      event.source.postMessage({ type: 'registered', id: data.id })
    }
  } else if (data.type === 'unregister') {
    streams.delete(data.id)
  }
})

function streamFromPort(port) {
  // Pull-based: the worker asks for one chunk at a time, so the page cannot run ahead.
  let pending = null
  port.onmessage = (event) => {
    const msg = event.data || {}
    if (!pending) return
    const resolve = pending
    pending = null
    resolve(msg)
  }
  const request = () =>
    new Promise((resolve) => {
      pending = resolve
      port.postMessage({ type: 'pull' })
    })
  return new ReadableStream({
    async pull(controller) {
      const msg = await request()
      if (msg.type === 'chunk') {
        controller.enqueue(new Uint8Array(msg.chunk))
      } else if (msg.type === 'close') {
        controller.close()
        port.close()
      } else if (msg.type === 'error') {
        controller.error(new Error(msg.message || 'stream errored'))
        port.close()
      }
    },
    cancel() {
      port.postMessage({ type: 'cancel' })
      port.close()
    }
  })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const marker = url.pathname.indexOf('/zipdl/')
  if (marker === -1) return
  const rest = url.pathname.slice(marker + '/zipdl/'.length).split('/')
  const id = rest[0]
  if (rest[1] === 'keepalive') {
    event.respondWith(new Response('ok', { headers: { 'Cache-Control': 'no-store' } }))
    return
  }
  const entry = streams.get(id)
  if (!entry) {
    event.respondWith(new Response('unknown download', { status: 404 }))
    return
  }
  streams.delete(id)
  const body = entry.stream || streamFromPort(entry.port)
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${entry.name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
  if (Number.isFinite(entry.size) && entry.size > 0) {
    headers['Content-Length'] = String(entry.size)
  }
  event.respondWith(new Response(body, { headers }))
})
