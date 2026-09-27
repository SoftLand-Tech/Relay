/**
 * Slash command support.
 *
 * The gateway owns the registry — never hardcode a command list. Fetch it at
 * runtime from `commands.catalog` (127 commands + 85 skills on the current
 * build) and rank completions with `complete.slash`, which is the same fuzzy
 * scorer the desktop TUI uses.
 *
 * Wire facts established against a live gateway (do not guess these):
 *  - `complete.slash` returns `text` WITHOUT the leading slash and `display`
 *    WITH it, for both commands and skills. A bare "/" returns the whole
 *    catalog (capped per kind server-side).
 *  - `commands.catalog.skills` keys DO include the leading slash ("/airtable").
 *    Building `/${key}` yields "//airtable", which the gateway rejects.
 *  - Execution is split and the gateway enforces it:
 *      built-ins  -> `slash.exec`   (params: { session_id, command })
 *      skills     -> `command.dispatch` (slash.exec answers 4018
 *                    "skill command: use command.dispatch")
 *    `command.dispatch` is tried first and 4018 means "fall through".
 *
 * Contract source of truth:
 *   ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.generated.ts
 */
import { atom } from 'nanostores'
import { log } from './log'

// src/lib/gateway pulls react-native storage, which plain node (scripts/)
// cannot load — so it is imported lazily and scripts can inject a fake with
// _useGatewayForTests() before calling anything that talks to the wire.
type GatewayModule = typeof import('./gateway')
let gwOverride: GatewayModule | null = null
export function _useGatewayForTests(g: GatewayModule | null) { gwOverride = g }
async function gw(): Promise<GatewayModule> {
  return gwOverride ?? import('./gateway')
}

export interface CatalogCommand {
  description: string
  argument_mode?: string
  desktop?: string
  aliases?: string[]
  subcommands?: string[]
}

export interface SlashSkill {
  usage?: number
  origin?: string
}

export interface CompletionItem {
  text: string
  display?: string
  meta?: string
  kind?: string
  replace_from?: number
}

// ── State ──────────────────────────────────────────────────────────────────

export const commandCatalog = atom<Record<string, CatalogCommand>>({})
export const commandSubcommands = atom<Record<string, string[]>>({})
export const commandAliases = atom<Record<string, string>>({})
export const skillCommands = atom<Record<string, SlashSkill>>({})
export const commandCategories = atom<Array<{ name: string; pairs: Array<[string, string]> }>>([])
export const catalogWarning = atom<string>('')
export const commandWarning = atom<string>('')

let loadedFor: string | null = null

// ── Fetch ──────────────────────────────────────────────────────────────────

/** Load the command registry. No-op when already loaded for this session. */
export async function loadCatalog(opts?: { force?: boolean; sessionId?: string }): Promise<void> {
  if (!opts?.force && loadedFor) return
  const { rpc } = await gw()
  try {
    const res = await rpc<CatalogResult>('commands.catalog', opts?.sessionId ? { session_id: opts.sessionId } : {})
    const cmds = res.commands ?? {}
    commandCatalog.set(cmds)
    commandSubcommands.set(res.sub ?? {})
    commandAliases.set(res.canon ?? {})
    skillCommands.set(res.skills ?? {})
    commandCategories.set(res.categories ?? [])
    catalogWarning.set(res.warning ?? '')
    loadedFor = opts?.sessionId ?? '*'
    log('info', 'slash', `catalog: ${Object.keys(cmds).length} commands, ${Object.keys(res.skills ?? {}).length} skills`)
  } catch (err) {
    log('info', 'slash', `commands.catalog failed: ${String(err)}`)
    commandWarning.set(err instanceof Error ? err.message : 'Could not load commands')
  }
}

interface CatalogResult {
  pairs?: Array<[string, string]>
  sub?: Record<string, string[]>
  canon?: Record<string, string>
  commands?: Record<string, CatalogCommand>
  categories?: Array<{ name: string; pairs: Array<[string, string]> }>
  skills?: Record<string, SlashSkill>
  skill_count?: number
  warning?: string
}

export function resetCatalog() {
  loadedFor = null
  commandCatalog.set({})
  commandSubcommands.set({})
  commandAliases.set({})
  skillCommands.set({})
  commandCategories.set([])
  catalogWarning.set('')
  commandWarning.set('')
}

// ── Parsing ────────────────────────────────────────────────────────────────

export interface ParsedCommand {
  name: string
  args: string
  raw: string
}

export function parseSlashCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  const spaceIdx = body.search(/\s/)
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase()
  if (!name) return null
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
  return { name, args, raw: text }
}

/**
 * Collapse a user-typed command name to one canonical word, no slashes.
 * Handles "//airtable" (skill keys already carry a slash) and "Airtable".
 */
export function normalizeCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase()
}

/** Map an alias/underscore variant to its canonical name, no slash. */
export function canonicalName(name: string): string {
  const key = normalizeCommandName(name)
  const canon = commandAliases.get()
  return (canon[key] ?? canon[`/${key}`] ?? key).replace(/^\//, '')
}

// ── Interactive hints (from the gateway's own registry) ────────────────────

/**
 * The composer mode the gateway declares for a command — "options" means the
 * argument is one of `subsFor()`, "mixed" adds free text on top. The desktop
 * composer reads the same field (hermes_cli/commands.py::infer_argument_mode),
 * so the app never hardcodes which commands want a picker.
 */
export function argumentModeFor(canonical: string): 'options' | 'mixed' | 'text' | null {
  const cmds = commandCatalog.get()
  const def = cmds[canonical] ?? cmds[`/${canonical}`]
  const mode = def?.argument_mode
  return mode === 'options' || mode === 'mixed' || mode === 'text' ? mode : null
}

/** Subcommand choices the gateway lists for a command (e.g. /reasoning levels). */
export function subsFor(canonical: string): string[] {
  const key = `/${canonical}`
  const fromSub = commandSubcommands.get()[key] ?? commandSubcommands.get()[canonical]
  if (fromSub?.length) return fromSub
  const cmds = commandCatalog.get()
  const def = cmds[canonical] ?? cmds[`/${canonical}`]
  return def?.subcommands ?? []
}

/** Catalog description for a canonical command name ('' when unknown). */
export function describeCommand(canonical: string): string {
  const cmds = commandCatalog.get()
  const def = cmds[canonical] ?? cmds[`/${canonical}`]
  return def?.description ?? ''
}

/**
 * What native UI a bare `/command` should open instead of the gateway's
 * usage text. `model` gets the full provider/model/scope picker; commands the
 * gateway marks options/mixed get a subcommand chooser — static `sub` lists
 * when the catalog has them, dynamic ones via `complete.slash` when not
 * (e.g. /personality lists the personality names). Everything else runs
 * through the gateway as before (text commands often work bare: /new, /reset…).
 */
export function interactiveTarget(
  canonical: string,
  args: string,
): 'model-picker' | 'options' | null {
  if (args) return null
  if (canonical === 'model') return 'model-picker'
  const mode = argumentModeFor(canonical)
  if (mode === 'options' || mode === 'mixed') return 'options'
  return null
}

// ── Completion ─────────────────────────────────────────────────────────────

/**
 * Ranked completions from the gateway's own scorer — the same fuzzy ranking
 * the desktop TUI uses, so a query like "/mo" also matches commands whose
 * description mentions it. Falls back to a local prefix match if the call
 * fails, so the palette still works offline.
 */
export async function completeSlash(prefix: string, sessionId?: string): Promise<CompletionItem[]> {
  const text = prefix.startsWith('/') ? prefix : `/${prefix}`
  try {
    const { rpc } = await gw()
    const res = await rpc<{ items?: CompletionItem[]; replace_from?: number }>('complete.slash', {
      text,
      ...(sessionId ? { session_id: sessionId } : {}),
    })
    if (res?.items?.length) return res.items
  } catch (err) {
    log('info', 'slash', `complete.slash failed, using local match: ${String(err)}`)
  }
  return localComplete(text)
}

function localComplete(text: string): CompletionItem[] {
  const body = text.slice(1)
  const spaceIdx = body.indexOf(' ')
  const namePart = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase().replace(/^\/+/, '')
  const cmds = commandCatalog.get()
  const canon = commandAliases.get()

  if (spaceIdx !== -1 && namePart) {
    const canonical = (canon[namePart] ?? namePart).replace(/^\//, '')
    const subs = commandSubcommands.get()[`/${canonical}`] ?? []
    const argPart = body.slice(spaceIdx + 1).split(/\s/)[0].toLowerCase()
    return subs
      .filter((o) => !argPart || o.toLowerCase().startsWith(argPart))
      .slice(0, 20)
      .map((o) => ({ text: o, display: `/${canonical} ${o}`, kind: 'option' }))
  }

  const out: CompletionItem[] = []
  for (const [name, def] of Object.entries(cmds)) {
    if (namePart && !name.toLowerCase().includes(namePart)) continue
    out.push({ text: name, display: name.startsWith('/') ? name : `/${name}`, meta: def.description?.slice(0, 90), kind: 'command' })
    if (out.length >= 60) break
  }
  // Skill keys already carry the leading slash — do not add another.
  for (const [name, skill] of Object.entries(skillCommands.get())) {
    if (namePart && !name.toLowerCase().includes(namePart)) continue
    const bare = name.replace(/^\//, '')
    out.push({ text: bare, display: `/${bare}`, meta: `skill · ${skill.origin ?? 'local'}`, kind: 'skill' })
    if (out.length >= 90) break
  }
  return out
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface SlashOutcome {
  /**
   * show    — render `text` as a local message (command printed something)
   * send    — send `text` as a real turn (the gateway asked for it)
   * prefill — put `text` in the composer without sending
   * none    — nothing to do
   */
  action: 'show' | 'send' | 'prefill' | 'none'
  text: string
  /** Canonical command name, for labelling the output. */
  name: string
}

/**
 * Run a slash command exactly the way the real Hermes does.
 *
 * Stage order mirrors the gateway: quick command -> plugin -> bundle -> skill
 * (all via `command.dispatch`, which returns a directive), then built-ins via
 * `slash.exec`. A 4018 from dispatch means "not one of mine" and is the
 * signal to fall through — it is not an error.
 */
export async function runCommand(input: string, sessionId: string): Promise<SlashOutcome> {
  const parsed = parseSlashCommand(input)
  if (!parsed) return { action: 'none', text: '', name: '' }

  const { rpc } = await gw()
  const canonical = canonicalName(parsed.name)
  const label = `/${canonical}`
  const argText = parsed.args

  // Skills and quick/plugin/bundle commands. Send the bare name — the
  // gateway rejects "//name", and skill keys already carry a slash.
  try {
    const d = await rpc<DispatchDirective>('command.dispatch', {
      name: canonical,
      arg: argText || null,
      session_id: sessionId,
    })
    if (d && d.type && d.type !== 'none') {
      return directiveToOutcome(d, label)
    }
  } catch (err) {
    const code = (err as { code?: number }).code
    // 4018 = "not a quick/plugin/bundle/skill command" -> built-in, fall through.
    // Anything else is a real failure worth surfacing (usage, permissions...).
    if (code !== 4018 && code !== -32601) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', 'slash', `dispatch /${canonical} failed: ${msg}`)
      return { action: 'show', text: `${label} — ${msg.replace(/^command\.dispatch:\s*/, '')}`, name: canonical }
    }
  }

  // Built-in. `slash.exec` takes `command` as a single string.
  const command = argText ? `${label} ${argText}` : label
  try {
    const res = await rpc<{ output?: string; warning?: string; type?: string; message?: string }>('slash.exec', {
      session_id: sessionId,
      command,
    })
    // slash.exec can reroute to a directive (queue/steer/goal/loop do this).
    if (res?.type && !res.output) {
      return directiveToOutcome(res as DispatchDirective, label)
    }
    if (res?.warning) log('info', 'slash', res.warning)
    return { action: 'show', text: res?.output?.trim() || `${label} — done`, name: canonical }
  } catch (err) {
    // The gateway's own message is what Hermes would print — surface it in
    // the chat rather than an alert, so it stays in the transcript.
    const msg = err instanceof Error ? err.message : String(err)
    return { action: 'show', text: `${label} — ${msg.replace(/^slash\.exec:\s*/, '')}`, name: canonical }
  }
}

interface DispatchDirective {
  type?: 'exec' | 'alias' | 'plugin' | 'send' | 'skill' | 'prefill' | 'none'
  output?: string
  target?: string
  message?: string
  notice?: string
  display?: string
  name?: string
  status?: string
}

function directiveToOutcome(d: DispatchDirective, label: string): SlashOutcome {
  switch (d.type) {
    case 'send':
      // The gateway wants this text sent as a real turn (e.g. /queue <prompt>).
      return { action: 'send', text: d.message ?? d.output ?? '', name: label }
    case 'prefill':
      // Put it in the composer for the user to review and send.
      return { action: 'prefill', text: d.output ?? d.message ?? '', name: label }
    case 'none':
      return { action: 'none', text: '', name: label }
    default:
      // exec / alias / plugin / skill — all print something.
      return {
        action: 'show',
        text: [d.output, d.notice].filter(Boolean).join('\n').trim() || `${label} — done`,
        name: label,
      }
  }
}
