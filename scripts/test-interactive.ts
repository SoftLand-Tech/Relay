/**
 * Test C — the interactive command layer: the /model picker flow and the
 * options/mixed subcommand choosers.
 *
 * Runs OFFLINE against a fake gateway (same harness as test-protocol.ts):
 *  - pure logic: scope flags, value-string building, switch interpretation
 *    (confirm_required / deferred), provider & model ranking, and which bare
 *    commands open a native picker (driven by the gateway's argument_mode)
 *  - the wire: the exact `config.set` / `model.options` / `model.save_key`
 *    frames the picker sends (params are extra="forbid" upstream — one wrong
 *    key is a 4000 on the real gateway)
 *
 *   npx tsx scripts/test-interactive.ts
 */
import ws from 'ws'
import {
  buildModelValue, scopeFlag, interpretModelSwitch, rankProviders, rankModels,
  applyModel, fetchModelOptions, saveProviderKey,
  liveModel, liveProvider, modelOptions,
  _useGatewayForTests,
} from '../src/lib/modelState'
import { interactiveTarget, argumentModeFor, subsFor, describeCommand, commandCatalog, commandSubcommands, resetCatalog } from '../src/lib/slash'
import { JsonRpcGatewayClient } from '../src/protocol/json-rpc-gateway'

const WebSocketServerImpl = ((ws as unknown as Record<string, unknown>).WebSocketServer ??
  (ws as unknown as Record<string, unknown>).Server) as typeof import('ws').WebSocketServer

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const READY = {
  type: 'gateway.ready',
  payload: { heartbeat: true, change_events: true, replay_epoch: 'itest00000001', skin: {} },
}

interface WireFrame {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

/** Frames the fake gateway received, by method — asserted after each step. */
async function withFakeGateway<T>(handlers: {
  'config.set'?: (params: Record<string, unknown>) => unknown
  'model.options'?: (params: Record<string, unknown>) => unknown
  'model.save_key'?: (params: Record<string, unknown>) => unknown
}, fn: (sent: Array<{ method: string; params: Record<string, unknown> }>, url: string) => Promise<T>): Promise<T> {
  const wss = new WebSocketServerImpl({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  wss.on('connection', (sock) => {
    sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: READY }))
    sock.on('message', (data: import('ws').RawData) => {
      let frame: WireFrame
      try { frame = JSON.parse(String(data)) as WireFrame } catch { return }
      if (frame.method === 'client.capabilities') {
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { server_requests: [] } }))
        return
      }
      if (typeof frame.method === 'string' && frame.params) {
        sent.push({ method: frame.method, params: frame.params })
        const h = (handlers as Record<string, ((p: Record<string, unknown>) => unknown) | undefined>)[frame.method]
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: h ? h(frame.params) : {} }))
      }
    })
  })
  const client = new JsonRpcGatewayClient({
    connectTimeoutMs: 8000,
    requestTimeoutMs: 8000,
    socketFactory: (url) => new WebSocket(url) as unknown as WebSocket,
  })
  const realGateway = {
    rpc: <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => client.request<T>(method, params),
    onEvent: () => () => {},
  }
  try {
    await client.connect(`ws://127.0.0.1:${port}/api/ws?token=t`)
    _useGatewayForTests(realGateway as unknown as typeof import('../src/lib/gateway'))
    return await fn(sent, `ws://127.0.0.1:${port}`)
  } finally {
    _useGatewayForTests(null)
    try { client.close() } catch {}
    wss.close()
  }
}

async function testPureHelpers() {
  console.log('\n— scope flags & value strings —')
  check('session flag', scopeFlag('session') === '--session')
  check('global flag', scopeFlag('global') === '--global')
  check('once flag', scopeFlag('once') === '--once')
  check('value with provider+scope', buildModelValue('glm-4.7', 'zai', 'global') === 'glm-4.7 --provider zai --global', buildModelValue('glm-4.7', 'zai', 'global'))
  check('value without provider', buildModelValue('claude-opus-4-6', null, 'session') === 'claude-opus-4-6 --session')
  check('value "unknown" provider dropped', buildModelValue('m', 'unknown', 'once') === 'm --once')

  console.log('\n— switch interpretation —')
  const confirm = interpretModelSwitch({ confirm_required: true, confirm_message: 'costly model', value: 'x' }, 'fallback')
  check('confirm_required surfaces the message', 'needsConfirm' in confirm && confirm.message === 'costly model')
  check('confirm path does not touch live atoms', liveModel.get() === '')

  const ok = interpretModelSwitch({ value: 'glm-4.7', scope: 'global', deferred: false, warning: null }, 'fallback', 'zai')
  check('success echoes gateway value', !('needsConfirm' in ok) && ok.model === 'glm-4.7')
  check('success reports scope', !('needsConfirm' in ok) && ok.scope === 'global')
  check('success updates live atoms', liveModel.get() === 'glm-4.7' && liveProvider.get() === 'zai')

  const def = interpretModelSwitch({ value: 'slow-model', scope: 'session', deferred: true }, 'fallback')
  check('deferred switch flagged', !('needsConfirm' in def) && def.deferred === true)

  const bare = interpretModelSwitch(null, 'kept-model')
  check('empty response falls back to requested model', !('needsConfirm' in bare) && bare.model === 'kept-model')

  console.log('\n— picker ranking —')
  const providers = rankProviders([
    { slug: 'b', name: 'B', authenticated: false, models: ['m'] },
    { slug: 'c', name: 'C', authenticated: true, models: ['m'] },
    { slug: 'a', name: 'A', authenticated: true, is_current: true, models: ['m'] },
  ])
  check('current provider first, unconfigured last', providers.map((p) => p.slug).join(',') === 'a,c,b')

  const p: Parameters<typeof rankModels>[0] = {
    slug: 'x', name: 'X',
    models: ['zeta', 'featured-b', 'alpha', 'dead-1', 'featured-a'],
    featured_models: ['featured-a', 'featured-b'],
    unavailable_models: ['dead-1'],
  }
  const models = rankModels(p)
  check('featured first, unavailable last, alpha in between',
    JSON.stringify(models) === JSON.stringify(['featured-a', 'featured-b', 'alpha', 'zeta', 'dead-1']),
    models.join(','))
}

async function testInteractiveTargets() {
  console.log('\n— which bare commands open pickers —')
  resetCatalog()
  commandCatalog.set({
    model: { description: 'Switch model', argument_mode: 'text' },
    reasoning: { description: 'Reasoning effort', argument_mode: 'options' },
    queue: { description: 'Queue a prompt', argument_mode: 'mixed' },
    new: { description: 'Start a new chat', argument_mode: 'text' },
    personality: { description: 'Pick a personality', argument_mode: 'options' },
  })
  commandSubcommands.set({
    '/reasoning': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    '/queue': ['list', 'add', 'clear'],
  })

  check('/model (bare) -> model picker', interactiveTarget('model', '') === 'model-picker')
  check('/model 4.7 (typed arg) -> gateway path', interactiveTarget('model', '4.7') === null)
  check('/reasoning (bare) -> option chooser', interactiveTarget('reasoning', '') === 'options')
  check('/reasoning high (typed arg) -> gateway path', interactiveTarget('reasoning', 'high') === null)
  check('/queue (mixed) -> chooser with free text', interactiveTarget('queue', '') === 'options')
  check('/new (text, no subs) -> gateway path', interactiveTarget('new', '') === null)
  check('/personality (options, subs unknown yet) -> chooser', interactiveTarget('personality', '') === 'options')
  check('argumentModeFor(queue) == mixed', argumentModeFor('queue') === 'mixed')
  check('subsFor(reasoning) from catalog', JSON.stringify(subsFor('reasoning')) === JSON.stringify(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
  check('describeCommand(model)', describeCommand('model') === 'Switch model')
}

async function testModelWireFlow() {
  console.log('\n— wire: picker flow against the fake gateway —')
  liveModel.set('')
  liveProvider.set('')
  modelOptions.set(null)

  const PROVIDERS = {
    providers: [
      { slug: 'zai', name: 'Z.ai', authenticated: true, is_current: true, models: ['glm-5.3-flash', 'glm-4.7'], featured_models: ['glm-4.7'], capabilities: { 'glm-4.7': { fast: true, reasoning: true } }, pricing: { 'glm-4.7': { input: '$1', output: '$2', free: false } } },
      { slug: 'openrouter', name: 'OpenRouter', authenticated: false, models: ['m1'], key_env: 'OPENROUTER_API_KEY' },
    ],
    model: 'glm-5.3-flash',
    provider: 'zai',
  }

  let configSetCalls = 0
  const firstParams: Record<string, unknown>[] = []
  const secondParams: Record<string, unknown>[] = []

  await withFakeGateway({
    'model.options': () => PROVIDERS,
    'config.set': (params) => {
      configSetCalls++
      if (configSetCalls === 1) {
        firstParams.push(params)
        return { key: 'model', value: params.value, confirm_required: true, confirm_message: 'This model is pricey.' }
      }
      secondParams.push(params)
      return { key: 'model', value: 'glm-4.7', scope: 'global', deferred: false }
    },
    'model.save_key': (params) => ({ provider: { slug: params.slug, name: 'OpenRouter', authenticated: true, models: ['m1'] } }),
  }, async (sent) => {
    // 1. Inventory
    const opts = await fetchModelOptions('live-1')
    check('model.options cached in atom', modelOptions.get()?.providers.length === 2)
    check('inventory echoes live model/provider', liveModel.get() === 'glm-5.3-flash' && liveProvider.get() === 'zai')
    const zai = opts.providers.find((p) => p.slug === 'zai')
    check('provider row usable by the picker', !!zai && rankModels(zai)[0] === 'glm-4.7')

    // 2. Guarded switch: first answer demands confirmation
    const r1 = await applyModel({ sessionId: 'live-1', model: 'glm-4.7', provider: 'zai', scope: 'global' })
    check('guarded switch returns needsConfirm', 'needsConfirm' in r1 && r1.message === 'This model is pricey.')
    check('confirm round did not write atoms yet', liveModel.get() === 'glm-5.3-flash')

    // 3. Confirmed retry commits
    const r2 = await applyModel({ sessionId: 'live-1', model: 'glm-4.7', provider: 'zai', scope: 'global', confirmed: true })
    check('confirmed switch returns the new model', !('needsConfirm' in r2) && r2.model === 'glm-4.7')
    check('confirmed switch reports gateway scope', !('needsConfirm' in r2) && r2.scope === 'global')
    check('atoms follow the committed switch', liveModel.get() === 'glm-4.7')

    // Wire shapes (extra="forbid" upstream — exact keys matter)
    check('config.set sent twice', configSetCalls === 2)
    check('frame 1 carries key/value/session_id', (() => {
      const p = firstParams[0]
      return p.key === 'model' && p.value === 'glm-4.7 --provider zai --global' && p.session_id === 'live-1' && !('confirm_expensive_model' in p)
    })(), JSON.stringify(firstParams[0]))
    check('frame 2 adds confirm_expensive_model only', (() => {
      const p = secondParams[0]
      return p.key === 'model' && p.confirm_expensive_model === true && !('deferred' in p)
    })(), JSON.stringify(secondParams[0]))

    // 4. save_key invalidates the cached inventory
    await saveProviderKey('openrouter', 'sk-test', 'live-1')
    check('save_key invalidated the cache', modelOptions.get() === null)
    const saveFrame = sent.find((f) => f.method === 'model.save_key')
    check('save_key frame shape', !!saveFrame && saveFrame.params.slug === 'openrouter' && saveFrame.params.api_key === 'sk-test' && saveFrame.params.session_id === 'live-1')
  })
}

async function main() {
  await testPureHelpers()
  await testInteractiveTargets()
  await testModelWireFlow()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
