import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Sidebar, type NavItem, type RecentChat } from './Sidebar'
import { C, S, useStyles, useShape } from '../lib/theme'
import { attentionById, rowStatus } from '../lib/attention'
import { isConnected as isConnectedAtom, rpc } from '../lib/gateway'
import {
  activeStoredId,
  busyStoredIds,
  pendingStoredIds,
  forgetSession,
  newChat,
  switchToSession,
  sessionsById,
} from '../lib/chat'
import { loadCatalog } from '../lib/slash'
import { loadSessions, patchRowTitle, sessionRows, toMs } from '../lib/sessionList'
import { forgetChatMarks, loadChatMarks, toggleArchive, togglePin } from '../lib/chatListState'

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
  const S = useShape()
  const s = useStyles(makeS)
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const online = useStore(isConnectedAtom)

  const pending = useStore(pendingStoredIds)
  const busy = useStore(busyStoredIds)
  const attention = useStore(attentionById)
  const current = useStore(activeStoredId)
  const all = useStore(sessionsById)
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

  // Pin/archive marks are app-local; restore them once at startup.
  React.useEffect(() => {
    void loadChatMarks()
  }, [])

  const nav = useMemo<NavItem[]>(() => [
    { key: 'chat', label: 'Chat', icon: 'chatbubble-outline' },
    { key: 'automations', label: 'Automations', icon: 'timer-outline' },
    { key: 'skills', label: 'Skills', icon: 'sparkles-outline' },
    { key: 'agent', label: 'Models', icon: 'cube-outline' },
    { key: 'settings', label: 'Settings', icon: 'settings-outline' },
  ], [])

  const recent = useMemo<RecentChat[]>(() => {
    // The server list is the source of truth: it covers every stored
    // conversation, and `started_at` is a real timestamp. Falling back to the
    // in-memory store (for a chat created before the first fetch landed) is
    // ordered by creation time, never by the per-session `lastSeq`.
    const statusOf = (id: string) => rowStatus(busy.includes(id), attention[id])
    const fromServer = rows.map((r) => ({
      id: r.id,
      title: r.title || r.preview?.slice(0, 60) || 'Untitled',
      ts: toMs(r.started_at),
      status: statusOf(r.id),
      active: r.id === current,
    }))

    const seen = new Set(fromServer.map((c) => c.id))
    const locals = Object.values(all)
      // `new:` pseudo ids are the optimistic new-chat window's stand-ins —
      // never drawer rows (their create may still fail).
      .filter((s) => s.storedId && !s.storedId.startsWith('new:') && !seen.has(s.storedId))
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
      .map((s) => ({
        id: s.storedId,
        title: s.title || 'New chat',
        ts: s.createdAtMs ?? 0,
        status: statusOf(s.storedId),
        active: s.storedId === current,
      }))

    // Uncapped: the sidebar's own search filters this list, and server rows
    // are bounded by the session.list fetch anyway.
    return [...locals, ...fromServer]
  }, [rows, all, busy, attention, current])

  const go = useCallback(
    (key: string) => {
      const route =
        key === 'chat'
          ? '/(tabs)/chat'
          : key === 'automations'
            ? '/(tabs)/automations'
            : key === 'skills'
              ? '/(tabs)/skills'
              : key === 'agent'
                ? '/(tabs)/agent'
                : '/(tabs)/settings'
      // navigate, never push: `/(tabs)` is a single route on the root stack,
      // so push mounts a whole fresh copy of every tab screen each tap —
      // navigate just switches the tab inside the instance we already have.
      router.navigate(route as never)
    },
    [router],
  )

  const startNew = useCallback(() => {
    // Navigate first — and the content swap is synchronous inside newChat
    // (a placeholder chat takes the screen in the same tick), with the
    // session.create RPC backgrounded behind it.
    router.navigate('/(tabs)/chat')
    void newChat().catch(() => {
      // The chat screen's retry banner surfaces the failure.
    })
  }, [router])

  const openChat = useCallback(
    (storedId: string) => {
      // Navigate first — and the content swap is synchronous inside
      // switchToSession (in-memory entry reuse, or a placeholder seeded from
      // the row + cached transcript), with the session.resume RPC
      // backgrounded behind it. Same shape as the notification deep-link in
      // app/_layout.tsx.
      router.navigate('/(tabs)/chat')
      void switchToSession(storedId).catch(() => {
        // The chat screen's retry banner surfaces the error.
      })
    },
    [router],
  )

  // ── Per-chat actions (surfaced by the sidebar's long-press / ⋯ menu) ──────
  // Each returns an error message for the dialog, or null on success —
  // react-native-web's Alert.alert is a no-op, so errors must render in-app.

  const liveIdOf = useCallback(
    (storedId: string) => Object.values(sessionsById.get()).find((s) => s.storedId === storedId)?.id,
    [],
  )

  const handlePinToggle = useCallback((id: string) => togglePin(id), [])
  const handleArchiveToggle = useCallback((id: string) => toggleArchive(id), [])

  const handleRename = useCallback(async (storedId: string, title: string) => {
    try {
      // `session.title` with an explicit title writes user-provenance; the
      // auto-titler never overwrites those, so a manual rename sticks.
      await rpc('session.title', { session_id: storedId, title })
      patchRowTitle([storedId], title)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Rename failed'
    }
  }, [])

  const handleDelete = useCallback(async (storedId: string) => {
    try {
      // The gateway refuses to delete the ACTIVE session: detach the UI into
      // a fresh chat first, then tear the old runtime down so the delete lands.
      if (activeStoredId.get() === storedId) await newChat()
      const live = liveIdOf(storedId)
      if (live) {
        try {
          await rpc('session.close', { session_id: live })
        } catch {
          // Best effort — a dead socket or an already-closed session must not
          // block the delete itself.
        }
      }
      await rpc('session.delete', { session_id: storedId })
      if (live) await forgetSession(live)
      // Drop the row so the drawer updates without waiting for a poll.
      sessionRows.set(sessionRows.get().filter((r) => r.id !== storedId))
      forgetChatMarks(storedId)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Delete failed'
    }
  }, [liveIdOf])

  return (
    <View style={s.root}>
      <View style={[s.topBar, { paddingTop: insets.top + (S.trayHeader ? 8 : 6) }]}>
        <Pressable
          style={({ pressed }) => [s.circle, pressed && s.circlePressed]}
          onPress={() => setOpen(true)}
          hitSlop={8}
          accessibilityLabel="Open menu"
        >
          <Ionicons name="menu" size={20} color={C.text} />
        </Pressable>

        <View style={s.titleWrap}>
          {showBrand ? <Text style={s.brand}>Moch</Text> : null}
          <Text style={[s.title, showBrand && s.titleDim]} numberOfLines={1}>
            {title}
          </Text>
        </View>

        {onSearch ? (
          <Pressable
            style={({ pressed }) => [s.circle, pressed && s.circlePressed]}
            onPress={onSearch}
            hitSlop={8}
            accessibilityLabel="Search chats"
          >
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
        onRequestOpen={() => setOpen(true)}
        nav={nav}
        recent={recent}
        onNav={go}
        onNewChat={startNew}
        onOpenChat={openChat}
        onPinToggle={handlePinToggle}
        onArchiveToggle={handleArchiveToggle}
        onRename={handleRename}
        onDelete={handleDelete}
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

const makeS = () => StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  // Mocheme: the top bar floats as a rounded tray card; Relay keeps the bare
  // bar that today's app renders.
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: S.trayHeader ? 0 : 8,
    marginHorizontal: S.trayHeader ? 10 : 0,
    marginTop: S.trayHeader ? 8 : 0,
    paddingVertical: S.trayHeader ? 8 : 0,
    backgroundColor: S.trayHeader ? C.bgCard : 'transparent',
    borderWidth: S.trayHeader ? 1 : 0,
    borderColor: C.border,
    borderRadius: S.trayHeader ? 24 : 0,
    shadowColor: '#000',
    shadowOpacity: S.trayHeader ? 0.35 : 0,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: S.trayHeader ? 8 : 0,
  },
  circle: {
    width: 38,
    height: 38,
    borderRadius: S.trayHeader ? 14 : 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: S.trayHeader ? C.bgElev : C.bgCard,
    borderWidth: S.trayHeader ? 1 : 0,
    borderColor: C.borderSoft,
  },
  circlePressed: { opacity: 0.55 },
  titleWrap: { flex: 1, paddingHorizontal: 4 },
  brand: { color: C.text, fontSize: 17, fontWeight: '700' },
  title: { color: C.text, fontSize: 16, fontWeight: '600' },
  titleDim: { fontSize: 13, color: C.textFaint, fontWeight: '500' },
  body: { flex: 1 },
  footerNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 6 },
  footerText: { color: C.textDim, fontSize: 12.5, flex: 1 },
})
