// Host-half test: drives the real route handlers `lib/host.js` installs, with
// a stub `llm` service, and asserts the JSON the browser half consumes.
//
// The routes only exist inside a running host, so this is how the assembly
// logic stays covered without restarting the live GUI.
//
// Run: node scripts/host-route.mjs
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// The host entry is plain ESM; import it the way the Node loader does.
const host = await import(join(root, 'lib/host.js'))

if (!host.inject.includes('llm') || !host.inject.includes('webServer')) {
  throw new Error('host half must inject llm + webServer')
}

/** Minimal `llm` stub: one healthy provider, one that throws, one bad model. */
const llm = {
  listProviders: () => [
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'broken', name: 'Broken' },
    { id: 'modlens-deepseek', name: 'DeepSeek (modlens vision)' },
  ],
  listModels: async (provider) => {
    if (provider === 'broken') throw new Error('provider unreachable')
    if (provider === 'deepseek') {
      return [
        { provider, id: 'deepseek-v4-flash', name: 'Flash' },
        { provider, id: 'ghost', name: 'Ghost' },
      ]
    }
    return [{ provider, id: 'deepseek-v4-flash', name: 'Flash (modlens vision)' }]
  },
  resolveModel: async (provider, model) => {
    if (model === 'ghost') throw new Error('unknown model')
    return {
      provider,
      id: model,
      name: model,
      inputModalities: provider === 'deepseek' ? ['text', 'image'] : ['text', 'image'],
      context: { contextWindow: provider === 'deepseek' ? 1000000 : 128000 },
    }
  },
}

/**
 * Apply the host half against a fresh stub web server, the way the Node
 * loader does per plugin. The stub context resolves `llm` through `get`,
 * which is exactly the accessor that fails once a real plugin fiber is
 * disposed — so every scenario can also break it to simulate disposal.
 * @param llmService - the service object the context hands out.
 * @returns the mounted context and its routes, keyed by path.
 */
function mount(llmService) {
  const routes = new Map()
  const ctx = {
    get(prop) {
      if (prop === 'llm') return llmService
      throw new Error(`cannot get service "${prop}"`)
    },
    webServer: { register: (route) => routes.set(route.path, route) },
  }
  host.apply(ctx)
  return { ctx, routes }
}

/** Invoke one handler with the smallest request/response pair. */
async function call(route, req) {
  let status = 0
  let body = ''
  let settle = () => {}
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    setHeader() {},
    end(chunk) { body = chunk; settle() },
    set statusCode(value) { status = value },
    get statusCode() { return status },
  }
  // The handler answers from an async IIFE, so wait for `end`, never a tick.
  route.handler(req, res)
  await done
  return { status, json: body === '' ? null : JSON.parse(body) }
}

/** One small POST body, streamed the way a real request arrives. */
function post(body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.setEncoding = () => {}
  process.nextTick(() => {
    req.emit('data', JSON.stringify(body))
    req.emit('end')
  })
  return req
}

const get = { method: 'GET' }

const TEST_PATH = '/api/model-picker/test'

// A host that never handed over the service reports it plainly instead
// of hanging. This must run before any successful capture: once `apply`
// has captured the service, a later apply without one keeps it.
const svcLess = mount(null)
const svcLessResult = await call(svcLess.routes.get(TEST_PATH), post({ provider: 'a', model: 'b' }))
if (svcLessResult.status !== 503 || svcLessResult.json.ok !== false) throw new Error('a missing llm service must answer 503')

// ─── The facts route ───
const facts = mount(llm)
const first = await call(facts.routes.get('/api/model-picker/models'), get)
console.log('route      :', facts.routes.get('/api/model-picker/models').path, `(${facts.routes.get('/api/model-picker/models').kind})`)
console.log('status     :', first.status)
console.log('rows       :', JSON.stringify(first.json.models))

const byKey = new Map(first.json.models.map((row) => [row.provider + '/' + row.id, row]))
if (first.status !== 200 || first.json.ok !== true) throw new Error('route did not answer ok')
if (byKey.get('deepseek/deepseek-v4-flash')?.contextWindow !== 1000000) throw new Error('context window missing')
if (byKey.get('deepseek/deepseek-v4-flash')?.input.join() !== 'text,image') throw new Error('modalities missing')
if (byKey.has('broken/anything')) throw new Error('a throwing provider leaked a row')
if (byKey.has('deepseek/ghost')) throw new Error('a throwing model leaked a row')
if (!byKey.has('modlens-deepseek/deepseek-v4-flash')) throw new Error('second provider missing')

// The second call must be served from cache: no new listProviders() work.
let calls = 0
const counting = { ...llm, listProviders: () => { calls += 1; return llm.listProviders() } }
const cached = mount(counting)
await call(cached.routes.get('/api/model-picker/models'), get)
await call(cached.routes.get('/api/model-picker/models'), get)
if (calls !== 0) throw new Error(`cache miss: listProviders ran ${String(calls)} times`)

// ─── The connection-test route ───

/** An `llm` whose `stream` records the request and replays a scripted stream. */
function testLlm(impl) {
  const seen = []
  return {
    seen,
    stream: (options) => {
      seen.push(options)
      return impl(options)
    },
  }
}

/** An async-iterable stream that yields the given chunks, then ends. */
const streamOf = (...chunks) => (async function* () {
  for (const chunk of chunks) yield chunk
})()

// A healthy route: the stream simply ends, so the test must report ok.
const healthy = testLlm(() => streamOf({ type: 'finish', reason: { kind: 'stop' } }))
const okMount = mount(healthy)
const okResult = await call(okMount.routes.get(TEST_PATH), post({ provider: 'deepseek', model: 'deepseek-v4-flash' }))
console.log('test ok    :', JSON.stringify(okResult.json))
if (okResult.status !== 200 || okResult.json.ok !== true) throw new Error('a healthy stream must test ok')
if (typeof okResult.json.ms !== 'number') throw new Error('ok result must carry ms')
const request = healthy.seen.at(-1)
if (request?.provider !== 'deepseek' || request?.model !== 'deepseek-v4-flash') throw new Error('the test must name the asked route')
if (request?.purpose !== 'model-picker-test') throw new Error('the test call must carry its purpose')
if (request?.maxTokens !== 16) throw new Error('the test call must stay tiny')
const message = request?.messages?.[0]
if (message?.role !== 'user' || message?.source?.kind !== 'dsh-model-picker') throw new Error('the test message must name its source')
if (message?.content?.[0]?.text !== 'Reply with OK.') throw new Error('the test message text is wrong')
if (typeof message?.id !== 'string' || message.id.length === 0) throw new Error('the test message must carry an identity')

// A failing route: the terminal error chunk carries the reason out.
const failing = testLlm(() => streamOf({ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'quota exhausted' } } }))
const failMount = mount(failing)
const failResult = await call(failMount.routes.get(TEST_PATH), post({ provider: 'zai', model: 'glm-5.3-flash' }))
console.log('test fail  :', JSON.stringify(failResult.json))
if (failResult.status !== 200 || failResult.json.ok !== false) throw new Error('an error finish must test as not ok')
if (failResult.json.error !== 'quota exhausted') throw new Error(`the failure message must surface, got ${JSON.stringify(failResult.json.error)}`)

// An aborted route (the 30s timeout): reported, not mistaken for health.
const aborted = testLlm(() => streamOf({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } }))
const abortMount = mount(aborted)
const abortResult = await call(abortMount.routes.get(TEST_PATH), post({ provider: 'slow', model: 'model' }))
if (abortResult.json.ok !== false || abortResult.json.error !== 'ABORTED') throw new Error('an aborted finish must test as not ok with its code')

// A stream that throws outright (adapter failure before the first chunk).
const exploding = testLlm(() => { throw new Error('adapter exploded') })
const explodeMount = mount(exploding)
const explodeResult = await call(explodeMount.routes.get(TEST_PATH), post({ provider: 'x', model: 'y' }))
if (explodeResult.json.ok !== false || explodeResult.json.error !== 'adapter exploded') throw new Error('a throwing stream must test as not ok with its message')

// Protocol guards: wrong method and malformed body.
const guardMount = mount(testLlm(() => streamOf()))
const methodResult = await call(guardMount.routes.get(TEST_PATH), { method: 'GET' })
if (methodResult.status !== 405) throw new Error('a GET must be refused with 405')
const bodyResult = await call(guardMount.routes.get(TEST_PATH), post({ provider: 7, model: null }))
if (bodyResult.status !== 400) throw new Error('a malformed body must be refused with 400')

// ─── The reported failure: the plugin's context dies, its routes live on ───
//
// A real plugin fiber can be disposed while the web server keeps serving
// the paths it registered; the old code read `ctx.llm` per request and
// every route then answered `cannot get required service "llm" in
// inactive context`. The handlers must keep answering from the service
// captured at apply time, with the context never touched again.
const stranded = mount(testLlm(() => streamOf({ type: 'finish', reason: { kind: 'stop' } })))
stranded.ctx.get = () => { throw new Error('cannot get required service "llm" in inactive context') }
const strandedModels = await call(stranded.routes.get('/api/model-picker/models'), get)
const strandedTest = await call(stranded.routes.get(TEST_PATH), post({ provider: 'deepseek', model: 'deepseek-v4-flash' }))
console.log('stranded   : models=%s test=%s', JSON.stringify(strandedModels.json.ok), JSON.stringify(strandedTest.json))
if (strandedModels.status !== 200 || strandedModels.json.ok !== true) throw new Error('the facts route must outlive its context')
if (strandedTest.status !== 200 || strandedTest.json.ok !== true) throw new Error('the test route must outlive its context')

console.log('HOST ROUTE OK')
