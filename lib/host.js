// Host half of dsh-model-picker.
//
// The browser half renders the composer model seat, but the catalog it reads
// (`ModelCatalogModel`) carries only id / name / description / reasoning — no
// context window, no input modalities. Those live on the Host's `llm` service,
// so this half republishes them over one loopback route and the client half
// badges each row from it.
//
// The Node-side loader imports this file as the package root entry, so it must
// stay Node-safe: no window/document access at module scope.
import { randomUUID } from 'node:crypto'

export const name = 'dsh-model-picker'

/** `llm` answers the facts; `webServer` carries the route to the browser. */
export const inject = ['llm', 'webServer']

/** Assembled snapshots are reused for this long; the model set rarely moves. */
const CACHE_MS = 30_000

const ROUTE = '/api/model-picker/models'
const TEST_ROUTE = '/api/model-picker/test'
const TEST_TIMEOUT_MS = 30_000
const registeredServers = new WeakSet()

/**
 * The Host's `llm` service, captured when the plugin applies.
 *
 * The service is owned by the Host's root fiber, so the object stays
 * functional long after this plugin's own fiber is disposed. The
 * registering context is not: once the fiber goes inactive, reading
 * `ctx.llm` throws `cannot get required service "llm" in inactive
 * context`, and every route bound to that context dies with it while
 * the web server keeps serving the path — the connection test then
 * reports "不通" for every model. Capturing the service object, never
 * the context, is what keeps these routes answering across a plugin
 * reload; `apply` refreshes the capture on every call, so a re-enabled
 * plugin picks up the live service again.
 */
let liveLlm = null

let cache = { at: 0, value: null }

/**
 * One row per configured provider/model pair, with the runtime facts the
 * browser catalog omits. Every provider and every model is isolated: an
 * adapter that cannot resolve one row (unreachable, mis-configured, outside
 * its wrap scope) drops that row instead of the whole snapshot.
 * @param llm - the Host LLM runtime service.
 * @returns the rows, in provider-then-adapter order.
 */
async function collect(llm) {
  const rows = []
  for (const provider of llm.listProviders()) {
    let listed
    try {
      listed = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of listed ?? []) {
      let info
      try {
        info = await llm.resolveModel(provider.id, model.id)
      } catch {
        info = undefined
      }
      // `listModels` is the cheaper source for modalities; `resolveModel` is
      // the only one that carries the context window.
      const modalities = info?.inputModalities ?? model.inputModalities
      const contextWindow = info?.context?.contextWindow
      // A row with neither fact would only repeat the browser's own catalog.
      if (contextWindow === undefined && !Array.isArray(modalities)) continue
      rows.push({
        provider: provider.id,
        id: model.id,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(Array.isArray(modalities) ? { input: [...modalities] } : {}),
      })
    }
  }
  return rows
}

/** Serve one JSON body without pulling in a framework. */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read one small JSON request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4096) reject(new Error('request too large'))
    })
    req.on('end', () => {
      try { resolve(raw === '' ? {} : JSON.parse(raw)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/**
 * Send one tiny prompt through the Host's own model runtime. The route is
 * healthy only when the stream finishes without an error chunk.
 * @param llm - the Host LLM runtime service.
 */
async function testModel(llm, provider, model) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  const started = Date.now()
  try {
    // The message carries the canonical shape the runtime assembles for
    // its own auxiliary calls: a fresh identity, a user role, and a
    // source naming this plugin. `purpose` attributes the call the same
    // way the session-title service does.
    const stream = llm.stream({
      provider,
      model,
      maxTokens: 16,
      purpose: 'model-picker-test',
      signal: controller.signal,
      messages: [{
        id: randomUUID(),
        role: 'user',
        source: { kind: 'dsh-model-picker' },
        content: [{ type: 'text', text: 'Reply with OK.' }],
      }],
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        const failure = chunk.reason.failure
        return { ok: false, ms: Date.now() - started, error: String(failure?.message ?? failure?.code ?? chunk.reason.kind) }
      }
    }
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: controller.signal.aborted ? 'timeout' : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param ctx - host plugin context carrying `llm` and `webServer`.
 */
export function apply(ctx) {
  // Capture the service object before anything can throw: the routes
  // below outlive this context, and the captured service is the only
  // reference that stays valid once the plugin's fiber is disposed.
  try {
    const service = ctx.get('llm')
    if (service !== null && service !== undefined) liveLlm = service
  } catch {
    // A host without the service keeps the previous capture; requests
    // then report the missing service instead of failing opaquely.
  }
  if (registeredServers.has(ctx.webServer)) return
  registeredServers.add(ctx.webServer)

  ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (_req, res) => {
      void (async () => {
        const llm = liveLlm
        if (llm === null) return sendJson(res, 503, { ok: false, error: 'the llm service is not available' })
        try {
          const now = Date.now()
          if (cache.value === null || now - cache.at > CACHE_MS) {
            cache = { at: now, value: await collect(llm) }
          }
          sendJson(res, 200, { ok: true, models: cache.value })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })()
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: TEST_ROUTE,
    handler: (req, res) => {
      void (async () => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const llm = liveLlm
        if (llm === null) return sendJson(res, 503, { ok: false, error: 'the llm service is not available' })
        try {
          const body = await readJson(req)
          if (typeof body.provider !== 'string' || typeof body.model !== 'string') return sendJson(res, 400, { ok: false, error: 'provider and model required' })
          sendJson(res, 200, await testModel(llm, body.provider, body.model))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })()
    },
  })
}
