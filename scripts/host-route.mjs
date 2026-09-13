// Host-half test: drives the real route handler `lib/host.js` installs, with a
// stub `llm` service, and asserts the JSON the browser half consumes.
//
// The route only exists inside a running host, so this is how the assembly
// logic stays covered without restarting the live GUI.
//
// Run: node scripts/host-route.mjs
import { readFileSync } from 'node:fs'
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

let registered = null
const ctx = {
  llm,
  webServer: { register: (route) => { registered = route } },
}

host.apply(ctx)
if (registered === null) throw new Error('host half registered no route')
console.log('route      :', registered.path, `(${registered.kind})`)

/** Invoke the captured handler with the smallest request/response pair. */
async function call() {
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
  registered.handler({}, res)
  await done
  return { status, json: JSON.parse(body) }
}

const first = await call()
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
host.apply({ llm: counting, webServer: { register: (route) => { registered = route } } })
await call()
await call()
if (calls !== 0) throw new Error(`cache miss: listProviders ran ${String(calls)} times`)

console.log('HOST ROUTE OK')
