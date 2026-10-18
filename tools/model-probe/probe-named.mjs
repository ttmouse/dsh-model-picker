#!/usr/bin/env node
// Probe an explicit list of gateway routes, one request each.
//
// The family sweep answers "can this channel serve this kind of model"; this
// answers "is this exact route id, the one I put in my daily plan, live right
// now". Reads the gateway key from disk and sends it only to the local gateway.
//
// Run: node tools/model-probe/probe-named.mjs [--timeout 20000] [--out <file>]
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
const CONCURRENCY = Math.max(1, Number(argOf('--concurrency', '3')))
const OUT = argOf('--out', 'tools/model-probe/results/named-routes.json')

/** The routes named for the daily burn plan: 4.1 first, then the GLM fallback. */
const ROUTES = [
  // primary — DeepSeek V4.1 / flash tier
  'buddy/deepseek-v4.1-flash',
  'codearts/deepseek-v4.1-flash',
  'loomy/DeepSeek-V4.1-Flash',
  'magpie/trae-cn/deepseek-v4.1-flash',
  'magpie/workbuddy/deepseek-v4.1-flash',
  'lobsterai/deepseek-flash',
  'qoder/dmodel',
  'qoder/dfmodel',
  // the channel the list names but the gateway may not serve
  'magpie/workbuddy-ai/deepseek-v4.1-flash',
  'magpie/workbuddy-ai/glm-5.3',
  'minimax/MiniMax-M3.1-Flash-Preview',
  // fallback — GLM 5.3
  'buddy/glm-5.3',
  'buddy/glm-5.3-flash',
  'codearts/glm-5.3-flash',
  'loomy/GLM-5.3-Flash',
  'lobsterai/glm-5.3',
  'lobsterai/glm-5.3-flash',
  'magpie/group/auto-glm-5-3',
  'magpie/group/auto-glm-5-3-flash',
  // Grok, as named
  'magpie-responses/grok/grok-4.7',
  'magpie/cursor/grok-4.7@500k',
  // Cursor Other Models window, the exact ids named
  'magpie/cursor/claude-opus-5-5@1m',
  'magpie/cursor/gpt-5.5@1m',
  'magpie/cursor/gemini-4-argon',
]

const key = readFileSync(KEY_FILE, 'utf8').trim()

const classify = (httpStatus, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const code = (typeof body === 'object' && body?.error?.code) || undefined
  const message = (typeof body === 'object' && body?.error?.message) || ''
  const ok = typeof body === 'object' && (Array.isArray(body?.choices) && body.choices.length > 0 || typeof body?.output !== 'undefined')
  if (ok) return { status: 'OK', code: code ?? '-', detail: '' }
  if (/expired|invalid_api_key|authentication_error|INVALID_CREDENTIAL|api_key/i.test(text)) return { status: 'AUTH', code: code ?? httpStatus, detail: '凭据无效或已过期' }
  if (/only be used from within|not entitled|Unpurchased|not subscribed|AccessDenied|not available in your region/i.test(text)) return { status: 'FORBIDDEN', code: code ?? 403, detail: message.slice(0, 110) || '无权访问该模型' }
  if (/MISSING_CREDENTIAL|no usable credential/i.test(text)) return { status: 'NO_CREDENTIAL', code: code ?? '-', detail: '未配置凭据' }
  if (/model_not_found|could not be resolved|does not exist|no configured model|unknown model/i.test(text)) return { status: 'MODEL_MISSING', code: code ?? 'model_not_found', detail: '模型不存在' }
  if (/insufficient|quota|credit|balance/i.test(text)) return { status: 'NO_QUOTA', code: code ?? '-', detail: message.slice(0, 110) || '额度或余额不足' }
  if (/rate.?limit|429/.test(text) || httpStatus === 429) return { status: 'RATE_LIMIT', code: code ?? 429, detail: '限流' }
  if (httpStatus === 0) return { status: 'TIMEOUT', code: 'timeout', detail: `${TIMEOUT_MS}ms 无响应` }
  return { status: 'ERROR', code: code ?? `HTTP ${httpStatus}`, detail: message.slice(0, 110) }
}

const probe = async (route) => {
  const started = Date.now()
  try {
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: route, max_tokens: 8, messages: [{ role: 'user', content: '回复 ok' }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const raw = await response.text()
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = { raw } }
    return { route, ...classify(response.status, parsed), ms: Date.now() - started, at: new Date().toISOString() }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || /aborted|timeout/i.test(String(error?.message))
    return { route, ...(timedOut ? { status: 'TIMEOUT', code: 'timeout', detail: `${TIMEOUT_MS}ms 无响应` } : { status: 'ERROR', code: 'network', detail: String(error?.message ?? error).slice(0, 110) }), ms: Date.now() - started, at: new Date().toISOString() }
  }
}

const main = async () => {
  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, ROUTES.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= ROUTES.length) return
      const result = await probe(ROUTES[index])
      results[index] = result
      process.stderr.write(`  ${result.route.padEnd(46)} ${result.status.padEnd(14)} ${String(result.ms).padStart(6)}ms  ${result.detail.slice(0, 70)}\n`)
    }
  })
  await Promise.all(workers)

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify({ schema: 'dsh-model-picker/named-routes/v1', gateway: GATEWAY, at: new Date().toISOString(), timeoutMs: TIMEOUT_MS, results }, null, 2)}\n`)
  const ok = results.filter((r) => r.status === 'OK')
  process.stderr.write(`\ndone: ${ok.length}/${results.length} OK · wrote ${OUT}\n`)
}

main().catch((error) => {
  process.stderr.write(`probe-named: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
