#!/usr/bin/env node
// Channel-level liveness sweep through the local channel-pack gateway.
//
// Probes the OpenAI-compatible gateway on 127.0.0.1:8326 — the same endpoint
// the desktop app serves its model picker from — so a result here is what the
// picker will actually do. One probe per (channel × model family), capped per
// channel, keeps spend minimal while still answering "which of my providers
// can serve which kinds of models right now".
//
// The gateway key is read from disk and sent only to the gateway; it is never
// printed. Results carry model ids and verdicts only.
//
// Run: node tools/model-probe/probe-gateway.mjs [--timeout 20000] [--concurrency 4]
//      [--families-per-channel 4] [--out tools/model-probe/results/<file>.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = homedir()
const GATEWAY = 'http://127.0.0.1:8326/v1'
const KEY_FILE = join(HOME, '.dsh/openai-gateway/api-key')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const TIMEOUT_MS = Number(argOf('--timeout', '20000'))
const CONCURRENCY = Math.max(1, Number(argOf('--concurrency', '4')))
const FAMILIES_PER_CHANNEL = Math.max(1, Number(argOf('--families-per-channel', '4')))
const OUT = argOf('--out', `tools/model-probe/results/gateway-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}.json`)

// Family order = probe priority when a channel serves more families than the
// cap: the families this machine actually routes work to, then the rest.
const FAMILY_ORDER = ['deepseek', 'glm', 'openai', 'claude', 'kimi', 'qwen', 'minimax', 'grok', 'gemini', 'doubao', 'muse', 'step', 'nova', 'llama', 'mistral', 'cohere', 'nemotron', 'kwaipilot', 'hunyuan', 'ernie', 'phi', 'olmo', 'spark', 'trae', 'other']

const familyOf = (id) => {
  const s = id.toLowerCase()
  const table = [
    [/deepseek/, 'deepseek'],
    [/glm|zhipu|zai/, 'glm'],
    [/claude|opus|sonnet|haiku/, 'claude'],
    [/gpt|o[1-9]-|codex|openai/, 'openai'],
    [/gemini|gemma/, 'gemini'],
    [/grok/, 'grok'],
    [/kimi|moonshot/, 'kimi'],
    [/qwen|qwq/, 'qwen'],
    [/minimax|abab/, 'minimax'],
    [/llama/, 'llama'],
    [/mistral|mixtral|magistral|devstral/, 'mistral'],
    [/muse/, 'muse'],
    [/kwaipilot|kat-/, 'kwaipilot'],
    [/trae/, 'trae'],
    [/doubao|seed|bytedance/, 'doubao'],
    [/ernie|wenxin/, 'ernie'],
    [/hunyuan/, 'hunyuan'],
    [/step-/, 'step'],
    [/spark/, 'spark'],
    [/command|cohere/, 'cohere'],
    [/nova/, 'nova'],
    [/phi/, 'phi'],
    [/nemotron/, 'nemotron'],
    [/olmo/, 'olmo'],
  ]
  for (const [re, name] of table) if (re.test(s)) return name
  return 'other'
}

// A magpie sub-route (`magpie/cursor/...`) is its own channel: each sub is a
// distinct upstream with its own quota, so merging them would hide outages.
const channelOf = (id) => {
  const parts = id.split('/')
  return parts[0] === 'magpie' ? parts.slice(0, 2).join('/') : parts[0]
}

// Prefer the cheap/fast tier of a family as its representative: flash/free/lite
// variants first, then plain ids, then everything else alphabetically.
const representativeRank = (id) => {
  const s = id.toLowerCase()
  if (/flash|free|lite|fast|highspeed|mini|small|haiku|nano/.test(s)) return 0
  if (/pro|max|opus|ultra|thinking|reasoning/.test(s)) return 2
  return 1
}

const key = readFileSync(KEY_FILE, 'utf8').trim()

const listModels = async () => {
  const response = await fetch(`${GATEWAY}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`gateway /v1/models -> HTTP ${response.status}`)
  const body = await response.json()
  return (body.data ?? []).map((m) => m.id).filter((id) => !id.endsWith(':batch'))
}

const buildCandidates = (routes) => {
  const byChannel = new Map()
  for (const id of routes) {
    const channel = channelOf(id)
    if (!byChannel.has(channel)) byChannel.set(channel, new Map())
    const families = byChannel.get(channel)
    const family = familyOf(id)
    if (!families.has(family)) families.set(family, [])
    families.get(family).push(id)
  }

  const candidates = []
  for (const [channel, families] of [...byChannel].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = [...families.keys()].sort((a, b) => {
      const ia = FAMILY_ORDER.indexOf(a)
      const ib = FAMILY_ORDER.indexOf(b)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    for (const family of ordered.slice(0, FAMILIES_PER_CHANNEL)) {
      const ids = families.get(family).sort((a, b) => representativeRank(a) - representativeRank(b) || a.localeCompare(b))
      candidates.push({ channel, family, model: ids[0], variants: ids.length })
    }
  }
  return { candidates, channelCount: byChannel.size }
}

const classify = (httpStatus, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const code = (typeof body === 'object' && body?.error?.code) || undefined
  const message = (typeof body === 'object' && body?.error?.message) || ''
  const ok = typeof body === 'object' && (Array.isArray(body?.choices) && body.choices.length > 0 || typeof body?.output !== 'undefined')
  if (ok) return { status: 'OK', code: code ?? '-', detail: '' }
  if (/expired|invalid_api_key|authentication_error|INVALID_CREDENTIAL|api_key/i.test(text)) return { status: 'AUTH', code: code ?? httpStatus, detail: '凭据无效或已过期' }
  if (/only be used from within|not entitled|Unpurchased|not subscribed|AccessDenied/i.test(text)) return { status: 'FORBIDDEN', code: code ?? 403, detail: message.slice(0, 100) || '无权访问该模型' }
  if (/MISSING_CREDENTIAL|no usable credential/i.test(text)) return { status: 'NO_CREDENTIAL', code: code ?? '-', detail: '未配置凭据' }
  if (/model_not_found|could not be resolved|does not exist|no configured model/i.test(text)) return { status: 'MODEL_MISSING', code: code ?? 'model_not_found', detail: '模型不存在' }
  if (/insufficient|quota|credit|balance/i.test(text)) return { status: 'NO_QUOTA', code: code ?? '-', detail: message.slice(0, 100) || '额度或余额不足' }
  if (/rate.?limit|429/.test(text) || httpStatus === 429) return { status: 'RATE_LIMIT', code: code ?? 429, detail: '限流' }
  if (httpStatus === 0) return { status: 'TIMEOUT', code: 'timeout', detail: `${TIMEOUT_MS}ms 无响应` }
  return { status: 'ERROR', code: code ?? `HTTP ${httpStatus}`, detail: message.slice(0, 100) }
}

const probe = async (candidate) => {
  const started = Date.now()
  try {
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: candidate.model, max_tokens: 8, messages: [{ role: 'user', content: '回复 ok' }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const raw = await response.text()
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = { raw } }
    return { ...candidate, ...classify(response.status, parsed), ms: Date.now() - started, at: new Date().toISOString() }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || /aborted|timeout/i.test(String(error?.message))
    return { ...candidate, ...(timedOut ? { status: 'TIMEOUT', code: 'timeout', detail: `${TIMEOUT_MS}ms 无响应` } : { status: 'ERROR', code: 'network', detail: String(error?.message ?? error).slice(0, 100) }), ms: Date.now() - started, at: new Date().toISOString() }
  }
}

const main = async () => {
  const routes = await listModels()
  const { candidates, channelCount } = buildCandidates(routes)
  console.error(`gateway ${GATEWAY} · ${routes.length} routes · ${channelCount} channels · ${candidates.length} probes · timeout ${TIMEOUT_MS}ms`)

  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= candidates.length) return
      const result = await probe(candidates[index])
      results[index] = result
      process.stderr.write(`  ${result.channel.padEnd(26)} ${result.family.padEnd(10)} ${result.status.padEnd(14)} ${String(result.ms).padStart(6)}ms  ${result.detail.slice(0, 60)}\n`)
    }
  })
  await Promise.all(workers)

  mkdirSync(dirname(OUT), { recursive: true })
  const payload = {
    schema: 'dsh-model-picker/gateway-liveness/v1',
    gateway: GATEWAY,
    at: new Date().toISOString(),
    timeoutMs: TIMEOUT_MS,
    routesTotal: routes.length,
    channelCount,
    probeCount: candidates.length,
    results,
  }
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)

  const ok = results.filter((r) => r.status === 'OK')
  console.error(`\ndone: ${ok.length}/${results.length} OK · ${results.length - ok.length} failed · wrote ${OUT}`)
}

main().catch((error) => {
  console.error(`probe-gateway: ${error?.message ?? error}`)
  process.exitCode = 1
})
