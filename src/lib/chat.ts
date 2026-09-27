import { atom, computed } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { rpc, onEvent, onServerRequest, getClient } from './gateway'
import { log } from './log'
import { notifyLocal, setBadge } from './push'
import { bindLiveId, upsertOptimisticRow } from './sessionList'

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  ts: number
  status?: 'ok' | 'failed'
  error?: string
}

export interface ToolItem {
  id: string
  name: string
  preview?: string
  status: 'running' | 'done' | 'failed'
  durationS?: number
}

export interface TodoItem {
  text: string
  done?: boolean
}

/** A live server->client question (approval / clarify / sudo / secret). */
export interface PendingRequest {
  /** The `srq-…` id. Answering is a JSON-RPC response frame carrying this id. */
  id: string
  method: 'approval' | 'clarify' | 'sudo' | 'secret'
  sessionId: string
  /** approval */
  command?: string
  description?: string
  choices?: string[]
  allowPermanent?: boolean
  allowSession?: boolean
  smartDenied?: boolean
  toolName?: string
  /** clarify */
  question?: string
  options?: string[]
  questions?: Array<{ qid: string; question?: string; choices?: string[]; multi_select?: boolean }>
  /** sudo / secret */
  prompt?: string
  envVar?: string
  replayed?: boolean
}

/** Everything the chat screen renders for one session. */
export interface SessionState {
  /** Live gateway session id (changes on every resume; used for RPCs + events). */
  id: string
  /** Durable id in the gateway's store (used to resume in a later app launch). */
  storedId: string
  /** Wall-clock ms this session was created locally, for ordering chats
   *  before the server's `started_at` is known. Never sort by `lastSeq` —
   *  that counter is per-session and meaningless across conversations. */
  createdAtMs: number
  title: string
  messages: ChatMessage[]
  tools: ToolItem[]
  thinking: string
  todos: TodoItem[]
  usage: string
  busy: boolean
  /**
   * The backend released this live session (idle timeout / LRU evict). The
   * transcript is still on screen but the handle is dead; the next send
   * transparently resumes it from its stored id.
   */
  detached?: boolean
  lastSeq: number
}

const EMPTY: SessionState = {
  id: '',
  storedId: '',
  createdAtMs: 0,
  title: '',
  messages: [],
  tools: [],
  thinking: '',
  todos: [],
  usage: '',
  busy: false,
  lastSeq: 0,
}

// ── Storage keys ───────────────────────────────────────────────────────────

/** The last session we were in, so relaunch lands back in the same conversation. */
const LAST_SESSION_KEY = 'hermes.activeSession.v1'
/** live session id -> stored session id, so a relaunch can resume it. */
const STORED_ID_MAP_KEY = 'hermes.storedIdMap.v1'
const OUTBOX_KEY = 'hermes.outbox.v1'
const transcriptKey = (sessionId: string) => `hermes.transcript.${sessionId}.v1`

export { LAST_SESSION_KEY as SESSION_KEY, STORED_ID_MAP_KEY }

const MAX_MESSAGES = 300
const MAX_TOOLS = 50
const MAX_OUTBOX = 20

// ── Store ──────────────────────────────────────────────────────────────────

/** Every session this app has touched, keyed by LIVE session id. */
export const sessionsById = atom<Record<string, SessionState>>({})
/** Which session the chat screen is showing. */
export const activeSession = atom<string | null>(null)
/** The active session's live id — the thing you pass to every scoped RPC. */
export const activeSessionId = computed(activeSession, id => (id && sessionsById.get()[id] ? id : null))
/** Server requests awaiting an answer, grouped by the session they block. */
const pendingBySession = atom<Record<string, PendingRequest[]>>({})
/** Queued prompts that could not be sent yet (offline). */
export const outbox = atom<string[]>([])

const view = computed([sessionsById, activeSession], (map, id): SessionState =>
  (id && map[id]) || EMPTY,
)

export const messages = computed(view, (s) => s.messages)
export const tools = computed(view, (s) => s.tools)
export const thinking = computed(view, (s) => s.thinking)
export const todos = computed(view, (s) => s.todos)
export const usage = computed(view, (s) => s.usage)
export const agentBusy = computed(view, (s) => s.busy)
export const activeTitle = computed(view, (s) => s.title)

/**
 * `session.list` returns DURABLE (stored) ids while every RPC and event is
 * keyed by the LIVE id. The session list has to bridge the two, so expose the
 * active session's stored id.
 */
export const activeStoredId = computed(view, (s) => s.storedId)

/** The question blocking the session the user is looking at, if any. */
export const pendingRequest = computed([pendingBySession, activeSession], (map, id): PendingRequest | null => {
  if (!id) return null
  const list = map[id]
  return list && list.length ? list[0] : null
})

/** How many questions are waiting across ALL sessions — drives the tab badge. */
export const pendingCount = computed(pendingBySession, map =>
  Object.values(map).reduce((n, l) => n + (l?.length ?? 0), 0),
)

/** True when any session has work in flight. */
export const anyBusy = computed(sessionsById, map => Object.values(map).some((s) => s.busy))

/** Stored ids of sessions with a turn running — for the session list. */
export const busyStoredIds = computed(sessionsById, map =>
  Object.values(map)
    .filter((s) => s.busy)
    .map((s) => s.storedId)
    .filter(Boolean),
)

/** Stored ids of sessions with an unanswered question — for the session list. */
export const pendingStoredIds = computed([sessionsById, pendingBySession], (map, pend): string[] => {
  const out: string[] = []
  for (const [liveId, list] of Object.entries(pend)) {
    if (list?.length) {
      const stored = map[liveId]?.storedId
      if (stored) out.push(stored)
    }
  }
  return out
})

let uid = 0
const nid = () => `m${Date.now()}_${uid++}`

// ── Helpers ────────────────────────────────────────────────────────────────

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
          if (typeof o.content === 'string') return o.content
        }
        return ''
      })
      .join('')
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

/** Mutate the active session's state. No-ops when nothing is active. */
function patchActive(patch: Partial<SessionState>) {
  const id = activeSession.get()
  if (!id) return
  const map = sessionsById.get()
  const cur = map[id]
  if (!cur) return
  sessionsById.set({ ...map, [id]: { ...cur, ...patch } })
}

function patchSession(id: string, patch: Partial<SessionState>) {
  const map = sessionsById.get()
  const cur = map[id]
  if (!cur) return
  sessionsById.set({ ...map, [id]: { ...cur, ...patch } })
}

function makeSession(id: string, storedId: string, title = '', createdAtMs = Date.now()): SessionState {
  return { ...EMPTY, id, storedId, title: title || 'New chat', createdAtMs }
}

// ── Transcript persistence (per session) ───────────────────────────────────

async function persistSession(id: string) {
  const s = sessionsById.get()[id]
  if (!s) return
  try {
    await AsyncStorage.setItem(transcriptKey(id), JSON.stringify(s.messages.slice(-MAX_MESSAGES)))
  } catch {
    /* best effort */
  }
}

/** Load a cached transcript for a session we know about but have no messages for. */
async function loadCachedTranscript(id: string) {
  const existing = sessionsById.get()[id]
  if (existing?.messages.length) return
  try {
    const raw = await AsyncStorage.getItem(transcriptKey(id))
    if (!raw) return
    const list = JSON.parse(raw) as ChatMessage[]
    if (Array.isArray(list) && list.length) {
      patchSession(id, { messages: list.slice(-MAX_MESSAGES) })
    }
  } catch {
    /* best effort */
  }
}

async function dropCachedTranscript(id: string) {
  try {
    await AsyncStorage.removeItem(transcriptKey(id))
  } catch {
    /* best effort */
  }
}

// ── Stored-id map (live id -> durable id, survives relaunch) ───────────────

let storedIdMap: Record<string, string> = {}

async function loadStoredIdMap() {
  try {
    const raw = await AsyncStorage.getItem(STORED_ID_MAP_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>
      if (parsed && typeof parsed === 'object') storedIdMap = parsed
    }
  } catch {
    storedIdMap = {}
  }
}

async function rememberStoredId(liveId: string, storedId: string) {
  if (!liveId || !storedId || storedIdMap[liveId] === storedId) return
  storedIdMap[liveId] = storedId
  // Bound the map so it can't grow forever.
  const entries = Object.entries(storedIdMap)
  if (entries.length > 200) storedIdMap = Object.fromEntries(entries.slice(-200))
  try {
    await AsyncStorage.setItem(STORED_ID_MAP_KEY, JSON.stringify(storedIdMap))
  } catch {
    /* best effort */
  }
}

export function storedIdFor(liveId: string): string | undefined {
  return storedIdMap[liveId]
}

// ── Outbox ─────────────────────────────────────────────────────────────────

async function persistOutbox() {
  try {
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.get()))
  } catch {
    /* best effort */
  }
}

function enqueueOffline(text: string) {
  outbox.set([...outbox.get(), text].slice(0, MAX_OUTBOX))
  void persistOutbox()
}

export async function loadOutbox() {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY)
    if (raw) {
      const list = JSON.parse(raw) as string[]
      if (Array.isArray(list)) outbox.set(list.filter((x) => typeof x === 'string').slice(0, MAX_OUTBOX))
    }
  } catch {
    /* best effort */
  }
}

export async function flushOutbox(): Promise<void> {
  const q = outbox.get()
  if (!q.length) return
  outbox.set([])
  await persistOutbox()
  for (const text of q) {
    try {
      await sendPrompt(text)
    } catch (err) {
      enqueueOffline(text)
      throw err
    }
  }
}

// ── Session lifecycle ──────────────────────────────────────────────────────

export interface ResumeResult {
  sessionId: string
  storedId: string
  messages: Array<Record<string, unknown>>
}

const CREATE_COLS = 120

/**
 * Create a fresh session. NOTE: the contract is `extra="forbid"` — passing an
 * unknown key (the old `rows`) is rejected with 4000 and the call fails, so
 * only ever send keys listed in SessionCreateParams.
 */
export async function createSession(title?: string): Promise<ResumeResult> {
  const res = await rpc<{ session_id?: string; stored_session_id?: string; messages?: Array<Record<string, unknown>> }>(
    'session.create',
    { title: title || 'Hermes Pocket', cols: CREATE_COLS, source: 'mobile' },
  )
  const id = res?.session_id
  if (!id) throw new Error('session.create returned no id')
  const storedId = res.stored_session_id ?? id
  await rememberStoredId(id, storedId)
  bindLiveId(storedId, id)
  // Show it in the drawer straight away rather than on the next session.list.
  upsertOptimisticRow(storedId, title || 'New chat')
  sessionsById.set({ ...sessionsById.get(), [id]: makeSession(id, storedId, title) })
  activeSession.set(id)
  await AsyncStorage.setItem(LAST_SESSION_KEY, storedId)
  return { sessionId: id, storedId, messages: res.messages ?? [] }
}

/**
 * Resume a stored session. Takes the DURABLE id (what `session.list` returns
 * and what we persist), returns the LIVE id used for RPCs and events.
 */
export async function resumeSession(storedId: string): Promise<ResumeResult> {
  const res = await rpc<{ session_id?: string; stored_session_id?: string; messages?: Array<Record<string, unknown>> }>(
    'session.resume',
    { session_id: storedId, cols: CREATE_COLS },
  )
  const id = res?.session_id
  if (!id) throw new Error('session.resume returned no id')
  const newStored = res.stored_session_id ?? storedId
  await rememberStoredId(id, newStored)
  bindLiveId(newStored, id)

  // Reuse the cached view if we already had this session (keeps scroll, tool
  // and todo state). The live handle is fresh, so clear `detached`.
  const existing = sessionsById.get()[id]
  sessionsById.set({
    ...sessionsById.get(),
    [id]: existing ? { ...existing, storedId: newStored, detached: false } : makeSession(id, newStored),
  })
  activeSession.set(id)
  await AsyncStorage.setItem(LAST_SESSION_KEY, newStored)
  if (res.messages?.length) applyHistory(id, res.messages)
  else await loadCachedTranscript(id)
  return { sessionId: id, storedId: newStored, messages: res.messages ?? [] }
}

/** Boot: restore the last session, or create one. Safe to call repeatedly. */
export async function ensureSession(): Promise<string> {
  const current = activeSession.get()
  if (current) {
    const state = sessionsById.get()[current]
    // A released session still has a usable stored id — bring it back rather
    // than letting the next send fail against a dead handle.
    if (state?.detached && state.storedId) {
      try {
        await resumeSession(state.storedId)
        return activeSession.get() ?? current
      } catch (err) {
        log('warn', 'chat', `could not reattach released session: ${String(err)}`)
        const fresh = await createSession()
        return fresh.sessionId
      }
    }
    return current
  }

  if (Object.keys(storedIdMap).length === 0) await loadStoredIdMap()

  const stored = await AsyncStorage.getItem(LAST_SESSION_KEY)
  if (stored) {
    try {
      const r = await resumeSession(stored)
      return r.sessionId
    } catch (err) {
      log('warn', 'chat', `resume failed, creating new: ${String(err)}`)
      try {
        await AsyncStorage.removeItem(LAST_SESSION_KEY)
      } catch {
        /* best effort */
      }
    }
  }
  const r = await createSession()
  return r.sessionId
}

export async function newChat(): Promise<string> {
  const r = await createSession()
  sessionsById.set({ ...sessionsById.get(), [r.sessionId]: makeSession(r.sessionId, r.storedId, 'New chat') })
  return r.sessionId
}

/** Switch the chat screen to a session the user picked. */
export async function switchToSession(storedId: string): Promise<string> {
  const r = await resumeSession(storedId)
  // Seed from the cache if the backend had nothing to give (lazy session).
  if (!r.messages?.length) await loadCachedTranscript(r.sessionId)
  return r.sessionId
}

/** Forget a session locally (backend delete is the caller's job). */
export async function forgetSession(liveId: string) {
  const map = { ...sessionsById.get() }
  delete map[liveId]
  sessionsById.set(map)
  const pend = { ...pendingBySession.get() }
  delete pend[liveId]
  pendingBySession.set(pend)
  delete storedIdMap[liveId]
  try {
    await AsyncStorage.setItem(STORED_ID_MAP_KEY, JSON.stringify(storedIdMap))
  } catch {
    /* best effort */
  }
  await dropCachedTranscript(liveId)
  if (activeSession.get() === liveId) activeSession.set(null)
}

/** Append a message the app produced itself (e.g. slash command output). */
export function pushLocalMessage(text: string, role: 'user' | 'assistant' = 'assistant') {
  const t = text.trim()
  if (!t) return
  const sid = activeSession.get()
  if (!sid) return
  const s = sessionsById.get()[sid]
  if (!s) return
  patchSession(sid, { messages: [...s.messages, { id: nid(), role, text: t.slice(0, 32000), ts: Date.now() }] })
  void persistSession(sid)
}

export function historyFor(sessionId: string) {
  return sessionsById.get()[sessionId]
}

export function applyHistory(sessionId: string, list?: Array<Record<string, unknown>>) {
  const mapped: ChatMessage[] = []
  for (const m of list ?? []) {
    const role = String(m.role ?? '') === 'user' ? 'user' : 'assistant'
    const raw = (m.content ?? m.text ?? '') as unknown
    const text = textOf(raw).trim()
    if (!text) continue
    if (text === '[object Object]') continue
    mapped.push({ id: nid(), role, text: text.slice(0, 8000), ts: Number(m.ts ?? m.timestamp ?? Date.now()) })
  }
  if (mapped.length) {
    patchSession(sessionId, { messages: mapped.slice(-MAX_MESSAGES) })
    void persistSession(sessionId)
  }
}

// ── Sending ────────────────────────────────────────────────────────────────

let sending = false

export async function sendPrompt(rawText: string) {
  const text = rawText.trim().slice(0, 8000)
  if (!text) return
  if (sending) {
    enqueueOffline(text)
    return
  }
  sending = true

  let sid = ''
  try {
    try {
      sid = await ensureSession()
    } catch (err) {
      // Offline — keep the message visible as failed with retry.
      patchActive({
        messages: [
          ...messages.get(),
          { id: nid(), role: 'user', text, ts: Date.now(), status: 'failed', error: err instanceof Error ? err.message : 'Not connected' },
        ],
      })
      enqueueOffline(text)
      throw err
    }

    patchActive({
      messages: [...messages.get(), { id: nid(), role: 'user', text, ts: Date.now() }],
      tools: [],
      thinking: '',
      busy: true,
    })
    void persistSession(sid)
    await rpc('prompt.submit', { session_id: sid, text })
  } catch (err) {
    patchActive({ busy: false })
    sending = false
    const sid2 = sid || activeSession.get()
    if (sid2) {
      const list = [...messages.get()]
      const idx = [...list].reverse().findIndex((m) => m.role === 'user' && m.text === text)
      if (idx >= 0) {
        const real = list.length - 1 - idx
        list[real] = { ...list[real], status: 'failed', error: err instanceof Error ? err.message : 'Send failed' }
        patchSession(sid2, { messages: list })
      }
    }
    throw err
  }
  sending = false
  // `busy` stays true until message.complete / status.update / error.
}

export async function retryMessage(id: string) {
  const sid = activeSession.get()
  if (!sid) return
  const m = sessionsById.get()[sid]?.messages.find((x) => x.id === id)
  if (!m || m.role !== 'user') return
  patchSession(sid, { messages: messages.get().filter((x) => x.id !== id) })
  await sendPrompt(m.text)
}

export async function stopRun() {
  const sid = activeSession.get()
  if (!sid) return
  try {
    await rpc('session.interrupt', { session_id: sid })
  } catch (err) {
    log('warn', 'chat', `interrupt failed: ${String(err)}`)
  }
  patchSession(sid, { busy: false })
}

export async function steerRun(text: string) {
  const sid = activeSession.get()
  const t = text.trim().slice(0, 4000)
  if (!sid || !t) return
  // Steering works WHILE busy — separate path from sendPrompt.
  await rpc('session.steer', { session_id: sid, text: t })
  patchSession(sid, { messages: [...messages.get(), { id: nid(), role: 'user', text: t, ts: Date.now() }] })
}

// ── Server request answers (v7) ────────────────────────────────────────────
//
// The backend asks us questions over the same socket. Answering is a JSON-RPC
// RESPONSE frame carrying the request's `srq-…` id — there is no
// `*.respond` RPC method. (`clarify.respond`, `sudo.respond` and
// `secret.respond` do not exist and answer -32601.)

function withPending(sessionId: string, fn: (list: PendingRequest[]) => PendingRequest[]) {
  const map = { ...pendingBySession.get() }
  map[sessionId] = fn(map[sessionId] ?? [])
  pendingBySession.set(map)
  refreshBadge()
}

function answer(id: string, result: Record<string, unknown>) {
  getClient()?.respondServerRequest(id, result)
}

/** Retire a answered/cancelled question from the queue for its session. */
function retire(req: PendingRequest) {
  withPending(req.sessionId, (list) => list.filter((r) => r.id !== req.id))
  refreshBadge()
}

export async function respondApproval(choice: 'once' | 'session' | 'always' | 'deny', all = false) {
  const req = pendingRequest.get()
  if (!req || req.method !== 'approval') return
  // v7 answer shape: { choice, all? }
  answer(req.id, { choice, all: all || undefined })
  retire(req)
  log('info', 'chat', `approval answered: ${choice}`)
}

export async function respondClarify(answerText: string) {
  const t = answerText.trim().slice(0, 4000)
  if (!t) return
  const req = pendingRequest.get()
  if (!req || req.method !== 'clarify') return
  // v7 answer shape: { answer } — or { answers } for a batch.
  answer(req.id, { answer: t })
  retire(req)
  log('info', 'chat', `clarify answered: ${req.id}`)
}

/** Answer a batch clarify with one answer per question id. */
export async function respondClarifyBatch(answers: Record<string, string>) {
  const req = pendingRequest.get()
  if (!req || req.method !== 'clarify') return
  answer(req.id, { answers })
  retire(req)
  log('info', 'chat', `clarify batch answered: ${req.id}`)
}

export async function respondPrivileged(allow: boolean, value?: string) {
  const req = pendingRequest.get()
  if (!req || (req.method !== 'sudo' && req.method !== 'secret')) return
  // v7 answer shape: { value }. A deny is an empty value — the backend treats
  // a blank secret as "not provided".
  answer(req.id, allow ? { value: value ?? '' } : {})
  retire(req)
  log('info', 'chat', `${req.method} ${allow ? 'allowed' : 'denied'}`)
}

// ── Server request intake ──────────────────────────────────────────────────

function onServerRequestMessage(req: {
  id: string
  method: string
  params: Record<string, unknown>
  replayed?: boolean
}): boolean {
  const p = req.params ?? {}
  const sessionId = typeof p.session_id === 'string' ? p.session_id : (activeSession.get() ?? '')

  switch (req.method) {
    case 'approval': {
      const item: PendingRequest = {
        id: req.id,
        method: 'approval',
        sessionId,
        command: typeof p.command === 'string' ? p.command.slice(0, 800) : undefined,
        description: typeof p.description === 'string' ? p.description.slice(0, 800) : undefined,
        choices: Array.isArray(p.choices) ? p.choices.map(String) : undefined,
        allowPermanent: p.allow_permanent === true,
        allowSession: p.allow_session === true,
        smartDenied: p.smart_denied === true,
        toolName: typeof p.tool_name === 'string' ? p.tool_name : undefined,
        replayed: req.replayed,
      }
      withPending(sessionId, (list) => [...list, item])
      if (isBackgrounded()) {
        void notifyLocal('Approval needed', item.command ?? item.description ?? 'The agent wants to run a command.', { screen: 'chat' })
      }
      return true
    }

    case 'clarify': {
      const item: PendingRequest = {
        id: req.id,
        method: 'clarify',
        sessionId,
        question: typeof p.question === 'string' ? p.question.slice(0, 1000) : undefined,
        options: Array.isArray(p.choices) ? p.choices.map(String).slice(0, 12) : undefined,
        questions: Array.isArray(p.questions)
          ? (p.questions as Array<Record<string, unknown>>).map((q) => ({
              qid: String(q.qid ?? ''),
              question: typeof q.question === 'string' ? q.question.slice(0, 1000) : undefined,
              choices: Array.isArray(q.choices) ? q.choices.map(String).slice(0, 12) : undefined,
              multi_select: q.multi_select === true,
            }))
          : undefined,
        replayed: req.replayed,
      }
      withPending(sessionId, (list) => [...list, item])
      if (isBackgrounded()) {
        void notifyLocal('Agent asks', item.question ?? 'Clarification needed', { screen: 'chat' })
      }
      return true
    }

    case 'sudo':
    case 'secret': {
      const item: PendingRequest = {
        id: req.id,
        method: req.method,
        sessionId,
        command: typeof p.command === 'string' ? p.command.slice(0, 800) : undefined,
        prompt:
          req.method === 'secret'
            ? (typeof p.prompt === 'string' ? p.prompt.slice(0, 500) : `Enter ${String(p.env_var ?? 'secret')}`)
            : (typeof p.command === 'string' ? p.command.slice(0, 500) : 'Elevated access requested'),
        envVar: typeof p.env_var === 'string' ? p.env_var : undefined,
        replayed: req.replayed,
      }
      withPending(sessionId, (list) => [...list, item])
      if (isBackgrounded()) {
        void notifyLocal(req.method === 'sudo' ? 'Sudo requested' : 'Secret requested', item.prompt ?? '', { screen: 'chat' })
      }
      return true
    }

    // Surfaces the phone has no UI for. Declining (return false) makes the
    // channel answer -32601 so the backend stops waiting instead of burning
    // the full deadline.
    default:
      log('warn', 'chat', `no handler for server request: ${req.method} (${req.id})`)
      return false
  }
}

// ── Event intake ───────────────────────────────────────────────────────────

function upsertToolIn(sessionId: string, t: ToolItem) {
  const s = sessionsById.get()[sessionId]
  if (!s) return
  const list = [...s.tools]
  const i = list.findIndex((x) => x.id === t.id)
  if (i >= 0) list[i] = { ...list[i], ...t }
  else list.push(t)
  patchSession(sessionId, { tools: list.slice(-MAX_TOOLS) })
}

/** True when the chat screen is currently showing this session's events. */
function isShowing(sessionId?: string): boolean {
  if (!sessionId) return false
  return sessionId === activeSession.get()
}

/** True when the user can't see the chat (background/inactive). */
function isBackgrounded(): boolean {
  try {
    return AppState.currentState !== 'active'
  } catch {
    return false
  }
}

function refreshBadge() {
  void setBadge(pendingCount.get())
}

let chatHooked = false

export function hookChatEvents() {
  if (chatHooked) return
  chatHooked = true

  // Server->client requests. Handled separately from events.
  onServerRequest(onServerRequestMessage)

  onEvent((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>
    const seq = e.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      const sid = e.session_id
      if (sid && sessionsById.get()[sid]) patchSession(sid, { lastSeq: seq })
    }

    const eSid = e.session_id
    if (!eSid) return
    const s = sessionsById.get()[eSid]
    if (!s) return // event for a session we're not tracking

    switch (e.type) {
      case 'session.info': {
        // SessionLiveInfo carries `title`; prefer the payload's own session_id
        // when present, otherwise the event's.
        const sid = typeof p.session_id === 'string' && sessionsById.get()[p.session_id] ? p.session_id : eSid
        const title = typeof p.title === 'string' && p.title ? p.title : undefined
        if (title) patchSession(sid, { title })
        if (typeof p.stored_session_id === 'string' && p.stored_session_id) {
          void rememberStoredId(sid, p.stored_session_id)
        }
        break
      }

      case 'session.title': {
        const title = typeof p.title === 'string' ? p.title : undefined
        if (title) patchSession(eSid, { title })
        break
      }

      case 'session.reclaimed': {
        // The backend evicted the live session (idle timeout / LRU evict). The
        // transcript is still valid, but the live handle is dead — mark it so
        // the next send transparently resumes instead of failing.
        log('warn', 'chat', `session reclaimed: ${String(p.reason)}`)
        patchSession(eSid, { busy: false, detached: true })
        if (isShowing(eSid)) {
          void notifyLocal(
            'Session released',
            `Hermes closed this session (${String(p.reason ?? 'idle')}). It will reconnect when you send.`,
            { screen: 'chat' },
          )
        }
        break
      }

      case 'session.usage': {
        const usage = p.usage as Record<string, unknown> | undefined
        const text = usage
          ? formatUsage(usage)
          : typeof p.text === 'string'
            ? p.text
            : ''
        if (text) patchSession(eSid, { usage: text })
        break
      }

      case 'todo.updated': {
        const items = (p.todos ?? p.items) as unknown
        if (Array.isArray(items)) {
          patchSession(eSid, {
            todos: items
              .slice(0, 30)
              .map((t) => {
                const o = (t ?? {}) as Record<string, unknown>
                return {
                  text: String(o.text ?? o.title ?? t ?? '').slice(0, 200),
                  done: !!(o.done ?? o.completed ?? o.status === 'done'),
                }
              })
              .filter((t) => t.text),
          })
        }
        break
      }

      case 'message.start': {
        const list = s.messages
        const last = list[list.length - 1]
        if (last?.role === 'assistant' && last.streaming) break
        patchSession(eSid, {
          messages: [...list, { id: nid(), role: 'assistant', text: '', streaming: true, ts: Date.now() }],
          thinking: '',
        })
        break
      }

      case 'message.delta': {
        const text = String(p.text ?? p.delta ?? '')
        if (!text) break
        const list = [...s.messages]
        let patched = false
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role === 'assistant' && list[i].streaming) {
            list[i] = { ...list[i], text: (list[i].text + text).slice(0, 32000), streaming: true }
            patched = true
            break
          }
        }
        if (!patched) {
          list.push({ id: nid(), role: 'assistant', text: text.slice(0, 32000), streaming: true, ts: Date.now() })
        }
        patchSession(eSid, { messages: list })
        break
      }

      case 'message.interim':
        break

      case 'message.complete': {
        const text = typeof p.text === 'string' ? p.text : ''
        const list = [...s.messages]
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role === 'assistant' && list[i].streaming) {
            const finalText = (text || list[i].text).slice(0, 32000)
            const failed = p.status === 'error' || !!p.error
            list[i] = {
              ...list[i],
              text: finalText,
              streaming: false,
              status: failed ? 'failed' : 'ok',
              error: failed ? String(p.error ?? p.failure_reason ?? 'Turn failed') : undefined,
            }
            break
          }
        }
        if (list.length) patchSession(eSid, { messages: list })
        patchSession(eSid, {
          tools: s.tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)),
          thinking: '',
          busy: false,
        })
        sending = false
        void persistSession(eSid)
        const finalText = text || list[list.length - 1]?.text || ''
        if (isBackgrounded() && finalText.trim()) {
          void notifyLocal('Agent replied', finalText.trim().slice(0, 180), { screen: 'chat' })
        }
        break
      }

      case 'thinking.delta':
      case 'reasoning.delta': {
        const text = String(p.text ?? p.delta ?? '')
        if (text) patchSession(eSid, { thinking: (s.thinking + text).slice(-4000) })
        break
      }

      case 'tool.start': {
        const id = String(p.tool_id ?? p.id ?? '')
        upsertToolIn(eSid, {
          id: id || nid(),
          name: String(p.name ?? 'tool'),
          preview: p.preview ? String(p.preview).slice(0, 200) : undefined,
          status: 'running',
        })
        break
      }

      case 'tool.generating': {
        // The model is still emitting the call's arguments.
        patchSession(eSid, { thinking: s.thinking })
        break
      }

      case 'tool.complete': {
        const id = String(p.tool_id ?? p.id ?? '')
        const failed = p.status === 'failed' || !!p.error
        if (!id) {
          const name = String(p.name ?? '')
          if (name) {
            const list = [...s.tools]
            const i = [...list].reverse().findIndex((t) => t.name === name && t.status === 'running')
            if (i >= 0) {
              const idx = list.length - 1 - i
              list[idx] = { ...list[idx], status: failed ? 'failed' : 'done', durationS: typeof p.duration_s === 'number' ? p.duration_s : list[idx].durationS }
              patchSession(eSid, { tools: list })
            }
          }
          break
        }
        upsertToolIn(eSid, {
          id,
          name: String(p.name ?? s.tools.find((t) => t.id === id)?.name ?? 'tool'),
          preview: p.preview ? String(p.preview).slice(0, 200) : undefined,
          durationS: typeof p.duration_s === 'number' ? p.duration_s : undefined,
          status: failed ? 'failed' : 'done',
        })
        break
      }

      case 'request.cancel': {
        // The backend withdrew a question (timeout / interrupt / session closed).
        // Tear the card down so the composer is not blocked by a dead question.
        const rid = String(p.id ?? '')
        const list = pendingBySession.get()[eSid] ?? []
        if (list.some((r) => r.id === rid)) {
          log('info', 'chat', `question withdrawn (${String(p.reason ?? 'unknown')})`)
          withPending(eSid, (l) => l.filter((r) => r.id !== rid))
        }
        break
      }

      case 'background.complete': {
        patchSession(eSid, { busy: false })
        sending = false
        log('info', 'chat', `background complete: ${JSON.stringify(p).slice(0, 200)}`)
        if (isBackgrounded()) {
          void notifyLocal('Background task done', String(p.text ?? JSON.stringify(p)).slice(0, 180), { screen: 'chat' })
        }
        break
      }

      case 'status.update': {
        if (p.busy === false) {
          patchSession(eSid, { busy: false })
          sending = false
        }
        break
      }

      case 'error': {
        const msg = String(p.message ?? p.error ?? 'Gateway error')
        const list = [...s.messages]
        const last = list[list.length - 1]
        if (last?.streaming) {
          list[list.length - 1] = { ...last, streaming: false, text: last.text || msg }
        } else {
          list.push({ id: nid(), role: 'assistant', text: msg, ts: Date.now(), status: 'failed', error: msg })
        }
        patchSession(eSid, { messages: list, busy: false })
        sending = false
        void persistSession(eSid)
        break
      }

      case 'notice': {
        const msg = String(p.message ?? '')
        if (msg && isBackgrounded()) void notifyLocal('Hermes', msg.slice(0, 180), { screen: 'chat' })
        break
      }
    }
  })
}

function formatUsage(u: Record<string, unknown>): string {
  const total = Number(u.total ?? 0)
  const input = Number(u.input ?? 0)
  const output = Number(u.output ?? 0)
  const cost = typeof u.cost === 'number' ? u.cost : undefined
  const parts = [`${total.toLocaleString()} tok`]
  if (input) parts.push(`in ${input.toLocaleString()}`)
  if (output) parts.push(`out ${output.toLocaleString()}`)
  if (cost !== undefined) parts.push(`$${cost.toFixed(3)}`)
  return parts.join(' · ')
}

export { refreshBadge }
