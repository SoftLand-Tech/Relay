import { atom, computed } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { JsonRpcGatewayClient, type GatewayEvent, type ConnectionState, type ServerRequest } from '../protocol/json-rpc-gateway'
import { RnWebSocketAdapter } from '../protocol/rn-socket'
import { log } from './log'

export interface ConnConfig {
  host: string // "127.0.0.1:9119" or "myserver.tailnet.ts.net:443"
  token: string
  tls: boolean
}

const HOST_KEY = 'hermes.connection.host.v2'
const TLS_KEY = 'hermes.connection.tls.v2'
const TOKEN_KEY = 'hermes.gateway.token'
const LEGACY_KEY = 'hermes.connection.v1'

export const connectionState = atom<ConnectionState>('idle')
export const connConfig = atom<ConnConfig | null>(null)
export const gatewayError = atom<string | null>(null)
export const reconnectAttempt = atom(0)
export const isConnected = computed(connectionState, (s) => s === 'open')
// Back-compat alias (old code imported `connected`)
export const connected = isConnected

let client: JsonRpcGatewayClient | null = null
let stopEvents: (() => void) | null = null
let stopState: (() => void) | null = null
let stopRequests: (() => void) | null = null
let wantConnection = false
let lastConfig: ConnConfig | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let connectGen = 0
let manualClose = false

type EventSink = (e: GatewayEvent) => void
const sinks = new Set<EventSink>()
export function onEvent(sink: EventSink): () => void {
  sinks.add(sink)
  return () => { sinks.delete(sink) }
}
function dispatch(e: GatewayEvent) {
  for (const s of sinks) {
    try { s(e) } catch (err) { log('error', 'gateway', `sink threw: ${String(err)}`) }
  }
}

type RequestSink = (req: ServerRequest) => boolean | void
const requestSinks = new Set<RequestSink>()
/**
 * Register a handler for server->client requests (approval, clarify, sudo,
 * secret, ...). Return `false` to decline; an unhandled request is answered
 * `-32601` so the backend stops waiting instead of burning its deadline.
 */
export function onServerRequest(sink: RequestSink): () => void {
  requestSinks.add(sink)
  return () => { requestSinks.delete(sink) }
}
function dispatchRequest(req: ServerRequest): boolean {
  for (const s of requestSinks) {
    let accepted: boolean | void
    try {
      accepted = s(req)
    } catch (err) {
      log('error', 'gateway', `server-request handler threw for ${req.method}: ${String(err)}`)
      return false
    }
    if (accepted !== false) return true
  }
  return false
}

/** Normalize "host[:port]" — accepts bare host, host:port, or full URLs. Throws on garbage. */
export function normalizeHost(raw: string): string {
  let h = raw.trim()
  if (!h) throw new Error('Enter the server address.')
  h = h.replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '')
  // strip path/query if user pasted a full URL
  const slash = h.indexOf('/')
  if (slash >= 0) h = h.slice(0, slash)
  const q = h.indexOf('?')
  if (q >= 0) h = h.slice(0, q)
  h = h.trim()
  if (!h || /\s/.test(h)) throw new Error('Invalid server address.')
  // basic hostname:port sanity — letters, digits, dots, dashes, colons (ipv6), brackets
  if (!/^[A-Za-z0-9.\-_:[\]]+$/.test(h)) throw new Error('Invalid server address.')
  if (h.length > 253) throw new Error('Server address too long.')
  return h
}

export function validateConfig(c: ConnConfig): ConnConfig {
  const host = normalizeHost(c.host)
  const token = c.token.trim()
  if (!token) throw new Error('Enter the token.')
  if (token.length > 4096) throw new Error('Token too long.')
  return { host, token, tls: !!c.tls }
}

function wsUrl(c: ConnConfig): string {
  return `${c.tls ? 'wss' : 'ws'}://${c.host}/api/ws?token=${encodeURIComponent(c.token)}`
}

/** Scrubbed URL safe for logs/UI — never prints the token. */
export function redactedUrl(c: ConnConfig): string {
  return `${c.tls ? 'wss' : 'ws'}://${c.host}/api/ws?token=***`
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().split(':')[0].replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('192.168.') || h.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

async function secureAvailable(): Promise<boolean> {
  try { return await SecureStore.isAvailableAsync() } catch { return false }
}

export async function loadSavedConfig(): Promise<ConnConfig | null> {
  try {
    // Migrate legacy plaintext bundle once
    const legacy = await AsyncStorage.getItem(LEGACY_KEY)
    if (legacy) {
      try {
        const c = JSON.parse(legacy) as ConnConfig
        if (c?.host && c?.token) {
          await saveConfig({ host: c.host, token: c.token, tls: !!c.tls })
          await AsyncStorage.removeItem(LEGACY_KEY)
          log('info', 'auth', 'migrated legacy connection to SecureStore')
          const loaded = await readStored()
          if (loaded) { connConfig.set(loaded); return loaded }
        }
      } catch {}
      await AsyncStorage.removeItem(LEGACY_KEY)
    }
    const loaded = await readStored()
    if (loaded) connConfig.set(loaded)
    return loaded
  } catch (err) {
    log('error', 'auth', `loadSavedConfig failed: ${String(err)}`)
    return null
  }
}

async function readStored(): Promise<ConnConfig | null> {
  const [host, tlsRaw] = await Promise.all([
    AsyncStorage.getItem(HOST_KEY),
    AsyncStorage.getItem(TLS_KEY),
  ])
  if (!host) return null
  let token: string | null = null
  if (await secureAvailable()) {
    token = await SecureStore.getItemAsync(TOKEN_KEY)
  } else {
    token = await AsyncStorage.getItem(TOKEN_KEY)
  }
  if (!token) return null
  return { host, token, tls: tlsRaw === '1' }
}

export async function saveConfig(c: ConnConfig) {
  const v = validateConfig(c)
  await AsyncStorage.setItem(HOST_KEY, v.host)
  await AsyncStorage.setItem(TLS_KEY, v.tls ? '1' : '0')
  if (await secureAvailable()) {
    await SecureStore.setItemAsync(TOKEN_KEY, v.token)
  } else {
    log('warn', 'auth', 'SecureStore unavailable (web?) — token in AsyncStorage')
    await AsyncStorage.setItem(TOKEN_KEY, v.token)
  }
  connConfig.set(v)
}

export async function clearConfig() {
  cancelReconnect()
  wantConnection = false
  lastConfig = null
  try { await AsyncStorage.multiRemove([HOST_KEY, TLS_KEY, TOKEN_KEY, LEGACY_KEY]) } catch {}
  try { await SecureStore.deleteItemAsync(TOKEN_KEY) } catch {}
  connConfig.set(null)
  gatewayError.set(null)
}

function ensureClient(): JsonRpcGatewayClient {
  if (client) return client
  const cli = new JsonRpcGatewayClient({
    socketFactory: (url: string) => new RnWebSocketAdapter(url) as unknown as WebSocket,
    connectTimeoutMs: 12_000,
    requestTimeoutMs: 120_000,
    onRequestHandlerError: (err, req) => log('error', 'gateway', `server request ${req.method} handler crashed: ${String(err)}`),
    onUnhandledRequest: (req) => log('warn', 'gateway', `no handler for server request ${req.method} (${req.id}) — answered -32601`),
    onSocketClose: (ev) => {
      // Returning false lets the client transition to 'closed'; we schedule reconnect below.
      void ev
    },
  })
  stopEvents?.()
  stopState?.()
  stopRequests?.()
  stopEvents = cli.onAny((e) => {
    dispatch(e)
  })
  stopRequests = cli.onRequest((req) => dispatchRequest(req))
  stopState = cli.onState((s) => {
    connectionState.set(s)
    if (s === 'closed' || s === 'error') {
      scheduleReconnect()
    }
    if (s === 'open') {
      reconnectAttempt.set(0)
      gatewayError.set(null)
    }
  })
  client = cli
  return cli
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
}

function scheduleReconnect() {
  if (!wantConnection || !lastConfig || manualClose) return
  if (reconnectTimer) return
  const attempt = reconnectAttempt.get() + 1
  reconnectAttempt.set(attempt)
  const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30_000)
  log('warn', 'gateway', `socket closed — retry #${attempt} in ${Math.round(delay / 1000)}s`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!wantConnection || manualClose || !lastConfig) return
    void dial(lastConfig, { isRetry: true }).catch(() => {})
  }, delay)
}

export async function retryNow(): Promise<void> {
  cancelReconnect()
  manualClose = false
  if (!lastConfig) {
    const saved = connConfig.get() ?? (await loadSavedConfig())
    if (!saved) throw new Error('No saved connection')
    lastConfig = saved
  }
  await dial(lastConfig, { isRetry: true })
}

async function dial(c: ConnConfig, opts?: { isRetry?: boolean }): Promise<void> {
  const gen = ++connectGen
  const v = validateConfig(c)
  lastConfig = v
  wantConnection = true
  manualClose = false
  gatewayError.set(null)
  connectionState.set('connecting')
  await saveConfig(v)

  if (!v.tls && !isLocalHost(v.host)) {
    log('warn', 'gateway', 'plain ws:// to non-local host — token travels unencrypted')
  }

  const cli = ensureClient()
  const url = wsUrl(v)
  log('info', 'gateway', `connecting ${redactedUrl(v)}${opts?.isRetry ? ' (retry)' : ''}`)

  let ready = false
  const stopReady = cli.onAny((e) => {
    if (e.type === 'gateway.ready') ready = true
  })
  try {
    await cli.connect(url)
  } catch (err) {
    stopReady()
    if (gen !== connectGen) return // superseded by newer dial
    connectionState.set('error')
    const msg = err instanceof Error ? err.message : 'Connection failed'
    gatewayError.set(`${redactedUrl(v)} — ${msg}`)
    log('error', 'gateway', `connect failed: ${msg}`)
    scheduleReconnect()
    throw err
  }
  if (gen !== connectGen) { stopReady(); return }

  // Wait briefly for gateway.ready; do NOT declare open-false-positive —
  // the socket-level client already set state to 'open'. If ready never
  // arrives we stay connected but warn (auth failures surface as RPC errors).
  await new Promise<void>((resolve) => {
    if (ready) return resolve()
    const t = setTimeout(resolve, 3000)
    const stop = cli.onAny((e) => {
      if (e.type === 'gateway.ready') { clearTimeout(t); stop(); resolve() }
    })
    setTimeout(() => { try { stop() } catch {} }, 3500)
  })
  stopReady()
  if (gen !== connectGen) return
  reconnectAttempt.set(0)
  connectionState.set('open')
  log('info', 'gateway', `connected ${redactedUrl(v)}${ready ? '' : ' (no gateway.ready yet)'}`)
}

export async function connect(c: ConnConfig): Promise<void> {
  cancelReconnect()
  await dial(c)
}

export function disconnect() {
  manualClose = true
  wantConnection = false
  cancelReconnect()
  connectGen++
  try { client?.close() } catch {}
  connectionState.set('idle')
}

/** Foreground resume — retry immediately if we were supposed to be connected. */
export function onForeground() {
  if (wantConnection && !manualClose && connectionState.get() !== 'open' && connectionState.get() !== 'connecting') {
    log('info', 'gateway', 'foreground resume — retrying')
    void retryNow().catch(() => {})
  }
}

export function getClient(): JsonRpcGatewayClient | null { return client }

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  if (!client) throw new Error('Not connected')
  if (timeoutMs !== undefined) return client.request<T>(method, params, timeoutMs)
  return client.request<T>(method, params)
}
