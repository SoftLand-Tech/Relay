/**
 * Slash command support.
 *
 * The gateway owns the registry — do not hardcode a command list. Fetch it at
 * runtime from `commands.catalog` (127 commands on the current build) and rank
 * completions with `complete.slash`, which is the same fuzzy scorer the desktop
 * app uses.
 *
 * Contract source of truth:
 *   ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.generated.ts
 *   hermes_cli/commands.py::COMMAND_REGISTRY
 */
import { atom } from 'nanostores'
import { rpc } from './gateway'
import { log } from './log'

export interface CommandDef {
  name: string
  description: string
  category?: string
  args_hint?: string
  subcommands?: string[]
  argument_mode?: 'options' | 'text' | 'mixed'
  desktop?: string
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

export interface CompletionItem {
  text: string
  display?: string
  meta?: string
  kind?: string
  replace_from?: number
}

// ── State ──────────────────────────────────────────────────────────────────

/** Canonical name -> def, fetched once per connection. */
export const commandCatalog = atom<Record<string, CatalogCommand>>({})
/** Canonical name -> its declared subcommands, for first-arg completion. */
export const commandSubcommands = atom<Record<string, string[]>>({})
/** lowercase alias -> canonical name. */
export const commandAliases = atom<Record<string, string>>({})
/** Skill commands (`/<name>`) the agent exposes. */
export const skillCommands = atom<Record<string, SlashSkill>>({})
/** Grouped for the palette. */
export const commandCategories = atom<Array<{ name: string; pairs: Array<[string, string]> }>>([])
export const catalogWarning = atom<string>('')
export const commandWarning = atom<string>('')

let loadedFor: string | null = null

// ── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Load the command registry from the gateway. Safe to call often — it is a
 * no-op when the catalog is already loaded for this session.
 */
export async function loadCatalog(opts?: { force?: boolean; sessionId?: string }): Promise<void> {
  if (!opts?.force && loadedFor) return
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
    log('error', 'slash', `commands.catalog failed: ${String(err)}`)
    commandWarning.set(err instanceof Error ? err.message : 'Could not load commands')
  }
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
  const raw = text
  const body = text.slice(1)
  const spaceIdx = body.search(/\s/)
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase()
  if (!name) return null
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
  return { name, args, raw }
}

/** Map an alias/underscore variant to its canonical `/name`. */
export function canonicalName(name: string): string {
  const key = name.toLowerCase().replace(/^\//, '').replace(/_/g, '-')
  const canon = commandAliases.get()
  return canon[key] ?? key
}

// ── Completion ─────────────────────────────────────────────────────────────

/**
 * Rank completions. Prefers the gateway's own scorer via `complete.slash`, and
 * falls back to a local prefix/substring match so the palette still works if
 * that call fails.
 */
export async function completeSlash(prefix: string, sessionId?: string): Promise<CompletionItem[]> {
  const text = prefix.startsWith('/') ? prefix : `/${prefix}`
  try {
    const res = await rpc<{ items?: CompletionItem[]; replace_from?: number }>('complete.slash', {
      text,
      ...(sessionId ? { session_id: sessionId } : {}),
    })
    if (res?.items?.length) return res.items
  } catch (err) {
    log('warn', 'slash', `complete.slash failed, using local match: ${String(err)}`)
  }
  return localComplete(text)
}

function localComplete(text: string): CompletionItem[] {
  const body = text.slice(1)
  const spaceIdx = body.indexOf(' ')
  const namePart = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase()
  const cmds = commandCatalog.get()
  const canon = commandAliases.get()

  if (spaceIdx !== -1 && namePart) {
    // First-arg completion from declared subcommands.
    const canonical = canon[namePart] ?? namePart
    const subs = commandSubcommands.get()[`/${canonical}`] ?? commandSubcommands.get()[`/${namePart}`] ?? []
    const argPart = body.slice(spaceIdx + 1).split(/\s/)[0].toLowerCase()
    return subs
      .filter((o) => !argPart || o.toLowerCase().startsWith(argPart))
      .slice(0, 20)
      .map((o) => ({ text: `/${canonical} ${o}`, kind: 'option' }))
  }

  const out: CompletionItem[] = []
  for (const [name, def] of Object.entries(cmds)) {
    if (namePart && !name.toLowerCase().includes(namePart)) continue
    out.push({ text: name, display: name, meta: def.description?.slice(0, 80), kind: 'command' })
    if (out.length >= 40) break
  }
  for (const [name, skill] of Object.entries(skillCommands.get())) {
    if (namePart && !name.toLowerCase().includes(namePart)) continue
    out.push({ text: `/${name}`, display: `/${name}`, meta: `skill · ${skill.origin ?? 'local'}`, kind: 'skill' })
    if (out.length >= 60) break
  }
  return out
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export interface DispatchDirective {
  type: 'exec' | 'alias' | 'plugin' | 'send' | 'skill' | 'prefill' | 'none'
  output?: string
  target?: string
  message?: string
  notice?: string
  display?: string
  name?: string
  status?: string
}

const SKIP_FALLTHROUGH = new Set(['/prefill', '/none'])

/**
 * Run a slash command.
 *
 * Stage order matters and mirrors the gateway: quick command -> plugin ->
 * bundle -> skill -> built-in. `command.dispatch` handles the first four and
 * returns a directive; built-ins go through `slash.exec`, whose param is
 * `command` (not `name`).
 */
export async function runCommand(input: string, sessionId: string): Promise<DispatchDirective> {
  const parsed = parseSlashCommand(input)
  if (!parsed) return { type: 'none' }

  const canonical = canonicalName(parsed.name)
  const spelled = `/${canonical}`

  try {
    const d = await rpc<DispatchDirective>('command.dispatch', {
      name: parsed.name,
      arg: parsed.args || null,
      session_id: sessionId,
    })
    if (d && d.type && !SKIP_FALLTHROUGH.has(spelled)) {
      if (d.type !== 'none') return d
    }
  } catch (err) {
    // 4018 = "not a quick/plugin/bundle/skill command" — expected for built-ins.
    const code = (err as { code?: number }).code
    if (code !== undefined && code !== 4018 && code !== -32601) {
      log('warn', 'slash', `command.dispatch failed: ${String(err)}`)
    }
  }

  // Built-in. `slash.exec` takes `command` as a single string.
  const command = parsed.args ? `${spelled} ${parsed.args}` : spelled
  const res = await rpc<{ output?: string; warning?: string }>('slash.exec', {
    session_id: sessionId,
    command,
  })

  if (res?.warning) log('warn', 'slash', res.warning)
  return { type: 'exec', output: res?.output ?? '', name: canonical }
}

/** Format a directive's output for a chat bubble. */
export function directiveToText(d: DispatchDirective): string {
  switch (d.type) {
    case 'send':
      return d.message ?? d.output ?? ''
    case 'prefill':
      return d.output ?? d.message ?? ''
    case 'alias':
    case 'exec':
    case 'plugin':
    case 'skill':
      return [d.output, d.notice].filter(Boolean).join('\n').trim() || (d.display ? `/${d.display}` : '')
    default:
      return ''
  }
}
