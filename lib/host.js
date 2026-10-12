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
 * Failure classes this route reports, in the order they are read off a
 * finished stream. `quota` and `rate` are the two the question "is this
 * route still worth picking" actually turns on: an exhausted balance and a
 * momentary throttle both look like a plain failure otherwise, and they call
 * for different answers from the reader (top up versus wait).
 *
 * The runtime already classifies both: `QUOTA` comes from an exhausted
 * account balance or spent credits, `RATE_LIMIT` from a throttled request,
 * and `ACCOUNT_QUOTA` from first-party token quota that the billing page
 * replenishes. A harness code is preferred when one is present; the provider
 * wording is only consulted when it is not, because `llm.stream()` hands back
 * whatever the adapter built and a third-party adapter may report neither.
 */
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
// The four English patterns are the Host's own quota classifier, mirrored so
// this route and the runtime never disagree about the same sentence; the
// Chinese patterns are appended because the channels on this machine answer
// in Chinese. Writing a narrower pattern here would silently downgrade a
// failure the runtime had already called quotal.
const QUOTA_WORDS = new RegExp(
  String.raw`\binsufficient[\s_-]+(?:quota|balance|credits?)\b`
  + String.raw`|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b`
  + String.raw`|\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b`
  + String.raw`|\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b`
  + String.raw`|\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b`
  // Chinese wording, appended because the channels on this machine answer in
  // Chinese — and because the Host's own classifier does NOT cover it. A live
  // 429 from zai-coding-cn reads 您已达到每周/每月使用上限…限额将在…重置,
  // which `isQuotaExceededError` returns false for: measured, not assumed.
  // Classing it as rate would be wrong too — the sentence names a weekly or
  // monthly cap and a reset date, which is a spent allowance, not a throttle.
  + String.raw`|达到每周|每周/每月使用上限|使用上限|限额将在|额度|余额不足|欠费`, 'iu')
const RATE_CODES = new Set(['RATE_LIMIT'])
const RATE_WORDS = new RegExp(
  String.raw`\brate[\s_-]+limit|\btoo[\s_-]+many[\s_-]+requests\b`
  + String.raw`|\b(?:quota|usage)[\s_-]+(?:per|each)\b`
  + String.raw`|\btry[\s_-]+again[\s_-]+(?:later|in)\b`
  + String.raw`|限流|频率限制|请求过于频繁|访问过于频繁`, 'iu')
const AUTH_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
const AUTH_WORDS = /\b(?:invalid|missing|no|bad)[\s_-]+(?:api[\s_-]?key|credential|token)\b|\bunauthoriz|\bforbidden\b|\bauthentication\b|密钥|未授权|权限不足/iu

/**
 * Decide which failure class a finished stream belongs to.
 *
 * Both inputs are read, and the harness code wins: an adapter that maps a
 * balance exhaustion onto `QUOTA` is right about it even when the provider
 * phrased the message in wording this table has never seen. Only when no
 * code names a class do the words get a say, which is what keeps a
 * third-party adapter that reports neither from collapsing into "failed".
 * @param code - the harness failure code (`failure.code`), if the runtime set one.
 * @param message - the human-readable failure text.
 * @returns one of `quota`, `rate`, or `undefined` when neither names a class.
 */
function classifyFailure(code, message) {
  const upper = typeof code === 'string' ? code.toUpperCase() : ''
  if (QUOTA_CODES.has(upper)) return 'quota'
  if (RATE_CODES.has(upper)) return 'rate'
  const text = typeof message === 'string' ? message : ''
  if (QUOTA_WORDS.test(text)) return 'quota'
  if (RATE_WORDS.test(text)) return 'rate'
  return undefined
}

/**
 * Send one tiny prompt through the Host's own model runtime.
 *
 * A finished stream without an error chunk is `ok`. Everything else is a
 * failure carrying a `state` the browser half renders verbatim: `quota`
 * (nothing left to spend), `rate` (throttled for now), `auth` (the
 * credential was rejected), or `error` for anything else — including the
 * timeout, which is its own string so a slow route is never mistaken for a
 * broken one.
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
        const message = String(failure?.message ?? failure?.code ?? chunk.reason.kind)
        const code = typeof failure?.code === 'string' ? failure.code : ''
        // An abort is this route's own 30s timeout, not the provider's
        // verdict, so it is reported as a timeout rather than classified.
        const state = chunk.reason.kind === 'aborted'
          ? 'timeout'
          : classifyFailure(code, message)
            ?? (AUTH_CODES.has(code.toUpperCase()) || AUTH_WORDS.test(message) ? 'auth' : 'error')
        return { ok: false, ms: Date.now() - started, state, error: message }
      }
    }
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    const aborted = controller.signal.aborted
    const message = aborted ? 'timeout' : String(error?.message ?? error)
    const code = typeof error?.code === 'string' ? error.code : ''
    return {
      ok: false,
      ms: Date.now() - started,
      state: aborted ? 'timeout' : classifyFailure(code, message) ?? (AUTH_CODES.has(code.toUpperCase()) || AUTH_WORDS.test(message) ? 'auth' : 'error'),
      error: message,
    }
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
