import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Sidebar, type NavItem, type RecentChat } from './Sidebar'
import { C } from '../lib/theme'
import { isConnected as isConnectedAtom } from '../lib/gateway'
import {
  activeStoredId,
  busyStoredIds,
  pendingStoredIds,
  newChat,
  switchToSession,
  sessionsById,
} from '../lib/chat'
import { loadCatalog, skillCommands } from '../lib/slash'
import { loadSessions, sessionRows } from '../lib/sessionList'

/**
 * ChatGPT-style shell: a compact top bar with a hamburger, the screen title,
 * and a status affordance on the right, plus the slide-in sidebar.
 *
 * Replaces the bottom tab bar entirely — navigation now happens through the
 * drawer, so the conversation gets the full height of the screen.
 */
export function ScreenShell({
  title,
  children,
  right,
  showBrand,
  onSearch,
}: {
  title: string
  children: React.ReactNode
  right?: React.ReactNode
  showBrand?: boolean
  onSearch?: () => void
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const online = useStore(isConnectedAtom)

  const pending = useStore(pendingStoredIds)
  const busy = useStore(busyStoredIds)
  const current = useStore(activeStoredId)
  const all = useStore(sessionsById)
  const skills = useStore(skillCommands)
  const rows = useStore(sessionRows)

  // The drawer's chat list comes from the gateway, so it has to be fetched.
  React.useEffect(() => {
    if (!online) return
    void loadSessions()
    // Refresh whenever the connection comes back.
  }, [online])

  // Keep it fresh: a new message lands, a title gets set.
  React.useEffect(() => {
    const id = setInterval(() => {
      if (online) void loadSessions()
    }, 60_000)
    return () => clearInterval(id)
  }, [online])

  React.useEffect(() => {
    void loadCatalog().catch(() => {})
  }, [])

  const nav = useMemo<NavItem[]>(() => {
    const items: NavItem[] = [
      { key: 'chat', label: 'Chat', icon: 'chatbubble-outline' },
      { key: 'sessions', label: 'Chats', icon: 'chatbubbles-outline' },
      { key: 'automations', label: 'Automations', icon: 'timer-outline' },
      { key: 'skills', label: 'Skills', icon: 'sparkles-outline' },
      { key: 'agent', label: 'Model & reasoning', icon: 'options-outline' },
    ]
    if (skills && Object.keys(skills).length) {
      items[3] = { ...items[3], badge: Object.keys(skills).length }
    }
    items.push({ key: 'settings', label: 'Settings', icon: 'settings-outline' })
    return items
  }, [skills])

  const recent = useMemo<RecentChat[]>(() => {
    // The server list is the source of truth: it covers every stored
    // conversation, and `started_at` is a real timestamp. Falling back to the
    // in-memory store (for a chat created before the first fetch landed) is
    // ordered by creation time, never by the per-session `lastSeq`.
    const fromServer = rows.map((r) => ({
      id: r.id,
      title: r.title || r.preview?.slice(0, 60) || 'Untitled',
      unread: pending.includes(r.id),
      busy: busy.includes(r.id),
      active: r.id === current,
    }))

    const seen = new Set(fromServer.map((c) => c.id))
    const locals = Object.values(all)
      .filter((s) => s.storedId && !seen.has(s.storedId))
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
      .map((s) => ({
        id: s.storedId,
        title: s.title || 'New chat',
        unread: pending.includes(s.storedId),
        busy: busy.includes(s.storedId),
        active: s.storedId === current,
      }))

    return [...locals, ...fromServer].slice(0, 40)
  }, [rows, all, pending, busy, current])

  const go = useCallback(
    (key: string) => {
      const route =
        key === 'chat'
          ? '/(tabs)/chat'
          : key === 'sessions'
            ? '/(tabs)/sessions'
            : key === 'automations'
              ? '/(tabs)/automations'
              : key === 'skills'
                ? '/(tabs)/skills'
                : key === 'agent'
                  ? '/(tabs)/agent'
                  : '/(tabs)/settings'
      router.push(route as never)
    },
    [router],
  )

  const startNew = useCallback(async () => {
    try {
      await newChat()
      router.push('/(tabs)/chat')
    } catch {
      router.push('/(tabs)/chat')
    }
  }, [router])

  const openChat = useCallback(
    async (storedId: string) => {
      try {
        await switchToSession(storedId)
      } catch {
        // Fall through to the chat tab; the banner surfaces the error.
      }
      router.push('/(tabs)/chat')
    },
    [router],
  )

  return (
    <View style={s.root}>
      <View style={[s.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable
          style={s.circle}
          onPress={() => setOpen(true)}
          hitSlop={8}
          accessibilityLabel="Open menu"
        >
          <Ionicons name="menu" size={20} color={C.text} />
        </Pressable>

        <View style={s.titleWrap}>
          {showBrand ? <Text style={s.brand}>Hermes</Text> : null}
          <Text style={[s.title, showBrand && s.titleDim]} numberOfLines={1}>
            {title}
          </Text>
        </View>

        {onSearch ? (
          <Pressable style={s.circle} onPress={onSearch} hitSlop={8} accessibilityLabel="Search chats">
            <Ionicons name="search" size={18} color={C.text} />
          </Pressable>
        ) : null}
        {right}
        <Pressable
          style={s.circle}
          hitSlop={8}
          accessibilityLabel={online ? 'Connected' : 'Not connected'}
        >
          <Ionicons
            name={online ? 'radio-button-on' : 'cloud-offline-outline'}
            size={18}
            color={online ? C.greenSoft : C.textFaint}
          />
        </Pressable>
      </View>

      <View style={s.body}>{children}</View>

      <Sidebar
        open={open}
        onOpen={() => {
          // Always re-read on open: the list is cheap, and it means a chat
          // created on another surface (or by a cron job) shows up without
          // waiting for the background poll.
          void loadSessions()
        }}
        onClose={() => setOpen(false)}
        nav={nav}
        recent={recent}
        onNav={go}
        onNewChat={startNew}
        onOpenChat={openChat}
        footer={
          pending.length > 0 ? (
            <View style={s.footerNote}>
              <Ionicons name="alert-circle" size={14} color={C.amber} />
              <Text style={s.footerText}>
                {pending.length} conversation{pending.length > 1 ? 's' : ''} waiting on you
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  circle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bgCard,
  },
  titleWrap: { flex: 1, paddingHorizontal: 4 },
  brand: { color: C.text, fontSize: 17, fontWeight: '700' },
  title: { color: C.text, fontSize: 16, fontWeight: '600' },
  titleDim: { fontSize: 13, color: C.textFaint, fontWeight: '500' },
  body: { flex: 1 },
  footerNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 6 },
  footerText: { color: C.textDim, fontSize: 12.5, flex: 1 },
})
