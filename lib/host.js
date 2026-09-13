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
export const name = 'dsh-model-picker'

/** `llm` answers the facts; `webServer` carries the route to the browser. */
export const inject = ['llm', 'webServer']

/** Assembled snapshots are reused for this long; the model set rarely moves. */
const CACHE_MS = 30_000

const ROUTE = '/api/model-picker/models'

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

/**
 * @param ctx - host plugin context carrying `llm` and `webServer`.
 */
export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (_req, res) => {
      void (async () => {
        try {
          const now = Date.now()
          if (cache.value === null || now - cache.at > CACHE_MS) {
            cache = { at: now, value: await collect(ctx.llm) }
          }
          sendJson(res, 200, { ok: true, models: cache.value })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })()
    },
  })
}
