import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Easing,
  Image,
  SectionList,
  TextInput,
  useWindowDimensions,
} from 'react-native'
import type { GestureResponderEvent } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { archivedIds, groupChats, pinnedIds } from '../lib/chatListState'
import { C } from '../lib/theme'

export interface NavItem {
  key: string
  label: string
  icon: keyof typeof Ionicons.glyphMap
  badge?: number
}

export interface RecentChat {
  id: string
  title: string
  /** Wall-clock ms of the chat's latest activity — drives the section grouping. */
  ts?: number
  /** Unread marker — a question is waiting on this conversation. */
  unread?: boolean
  busy?: boolean
  active?: boolean
}

/** Actions return an error message to show in the dialog, or null on success. */
type ChatAction = (id: string) => Promise<string | null>

interface Props {
  open: boolean
  onClose: () => void
  onOpen?: () => void
  nav: NavItem[]
  recent: RecentChat[]
  onNav: (key: string) => void
  onNewChat: () => void
  onOpenChat: (id: string) => void
  onPinToggle?: (id: string) => void
  onArchiveToggle?: (id: string) => void
  onRename?: (id: string, title: string) => Promise<string | null>
  onDelete?: ChatAction
  footer?: React.ReactNode
}

interface Section {
  key: string
  label: string
  data: RecentChat[]
  collapsible?: boolean
  /** Real item count — a collapsed section reports data=[] but still shows its header. */
  count?: number
}

/**
 * Mount/unmount with a pop animation instead of solid appearing/disappearing.
 * visible=true mounts and eases to 1; visible=false eases back to 0 and only
 * then unmounts, so the exit transition actually plays. Overlays rendered with
 * this must keep their last data around while fading out (see the refs next
 * to each call site).
 */
function usePopFade(visible: boolean, inMs = 150, outMs = 130) {
  const anim = useRef(new Animated.Value(0)).current
  const [rendered, setRendered] = useState(visible)
  useEffect(() => {
    if (visible) {
      setRendered(true)
      const a = Animated.timing(anim, {
        toValue: 1,
        duration: inMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      })
      a.start()
      return () => a.stop()
    }
    const a = Animated.timing(anim, {
      toValue: 0,
      duration: outMs,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    })
    a.start(({ finished }) => {
      if (finished) setRendered(false)
    })
    return () => a.stop()
  }, [visible, anim, inMs, outMs])
  return { anim, rendered }
}

/**
 * ChatGPT-style slide-in sidebar.
 *
 * Implemented as an overlay rather than a Drawer navigator: the app already
 * routes through expo-router tabs, and an overlay keeps that intact while
 * giving the same "drawer slides over the conversation" behaviour.
 *
 * All sessions live here. The list is grouped into sections (Pinned / Today /
 * Yesterday / Previous 7 days / Older / Archived) and every row exposes its
 * actions through long-press or the trailing ⋯ button: pin, rename, archive,
 * delete. Like ChatGPT, the menu is a small popover anchored AT the row you
 * pressed — not a bottom sheet — with icon rows and no Cancel (tapping
 * outside closes it), and every overlay fades/scales in and out instead of
 * popping solid. Dialogs are in-app overlays rather than Alert.alert because
 * react-native-web's Alert is a silent no-op.
 */
export function Sidebar({
  open,
  onClose,
  onOpen,
  nav,
  recent,
  onNav,
  onNewChat,
  onOpenChat,
  onPinToggle,
  onArchiveToggle,
  onRename,
  onDelete,
  footer,
}: Props) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const anim = useRef(new Animated.Value(0)).current
  // Stay mounted through the close animation, then unmount.
  const [mounted, setMounted] = useState(open)
  // ChatGPT's panel is ~300dp, capped so it never looks empty on a tablet.
  const panelWidth = Math.min(width * 0.82, 320)
  const [query, setQuery] = useState('')
  const [archOpen, setArchOpen] = useState(false)

  // Per-chat action state. The three overlays are mutually exclusive.
  const [menuFor, setMenuFor] = useState<RecentChat | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<RecentChat | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirming, setConfirming] = useState<RecentChat | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  // Each overlay fades out before unmounting; the refs keep its data (chat +
  // anchor) available so the exit animation still has something to render.
  const menuOpen = menuFor != null
  const { anim: menuAnim, rendered: menuRendered } = usePopFade(menuOpen)
  const menuRef = useRef<{ chat: RecentChat; anchor: { x: number; y: number } } | null>(null)
  useEffect(() => {
    if (menuFor && menuAnchor) menuRef.current = { chat: menuFor, anchor: menuAnchor }
  }, [menuFor, menuAnchor])
  const shownMenu = menuRendered ? menuRef.current : null

  const renameOpen = renaming != null
  const { anim: renameAnim, rendered: renameRendered } = usePopFade(renameOpen)
  const renameRef = useRef<RecentChat | null>(null)
  useEffect(() => {
    if (renaming) renameRef.current = renaming
  }, [renaming])
  const shownRename = renameRendered ? renameRef.current : null

  const confirmOpen = confirming != null
  const { anim: confirmAnim, rendered: confirmRendered } = usePopFade(confirmOpen)
  const confirmRef = useRef<RecentChat | null>(null)
  useEffect(() => {
    if (confirming) confirmRef.current = confirming
  }, [confirming])
  const shownConfirm = confirmRendered ? confirmRef.current : null

  const pinned = useStore(pinnedIds)
  const archived = useStore(archivedIds)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setQuery('')
      Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start()
      return
    }
    // Leaving also drops any open dialog so nothing survives into the next open.
    setMenuFor(null)
    setMenuAnchor(null)
    setRenaming(null)
    setConfirming(null)
    setDialogError(null)
    const a = Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true })
    a.start(({ finished }) => {
      if (finished) setMounted(false)
    })
    onOpen?.()
  }, [open, anim])

  const searching = query.trim().length > 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Search spans everything, including the archive.
    if (!q) return recent
    return recent.filter((c) => c.title.toLowerCase().includes(q))
  }, [recent, query])

  const sections = useMemo<Section[]>(() => {
    if (searching) return [{ key: 'results', label: '', data: filtered }]
    const groups = groupChats(recent, pinned, archived)
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      // Collapsed archive keeps its header but hides its rows.
      data: g.key === 'archived' && !archOpen ? [] : g.items,
      collapsible: g.key === 'archived',
      count: g.items.length,
    }))
  }, [recent, pinned, archived, searching, filtered, archOpen])

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] })

  const closeDialogs = () => {
    setMenuFor(null)
    setMenuAnchor(null)
    setRenaming(null)
    setConfirming(null)
    setDialogError(null)
  }

  /** ChatGPT-style: the menu pops open AT the row that was pressed. */
  const openMenu = (c: RecentChat, e?: GestureResponderEvent) => {
    const n = e?.nativeEvent
    setMenuAnchor({
      x: typeof n?.pageX === 'number' ? n.pageX : width - 40,
      y: typeof n?.pageY === 'number' ? n.pageY : 220,
    })
    setMenuFor(c)
  }

  const openRename = (c: RecentChat) => {
    setMenuFor(null)
    setRenaming(c)
    setRenameText(c.title)
    setDialogError(null)
  }

  const openDelete = (c: RecentChat) => {
    setMenuFor(null)
    setConfirming(c)
    setDialogError(null)
  }

  const saveRename = async () => {
    if (!renaming || dialogBusy) return
    const title = renameText.trim()
    if (!title) return
    setDialogBusy(true)
    setDialogError(null)
    const err = (await onRename?.(renaming.id, title)) ?? null
    setDialogBusy(false)
    if (err) setDialogError(err)
    else closeDialogs()
  }

  const runDelete = async () => {
    if (!confirming || dialogBusy) return
    setDialogBusy(true)
    setDialogError(null)
    const err = (await onDelete?.(confirming.id)) ?? null
    setDialogBusy(false)
    if (err) setDialogError(err)
    else closeDialogs()
  }

  if (!mounted) return null

  const menuPinned = shownMenu ? pinned.includes(shownMenu.chat.id) : false
  const menuArchived = shownMenu ? archived.includes(shownMenu.chat.id) : false

  // Popover geometry: right edge hugs the press point (the ⋯ button), growing
  // leftward; falls back to the left edge for long-presses mid-row. Vertically
  // it aligns just above the press point and clamps to the window.
  const MENU_W = 240
  const MENU_H = 4 * 46 + 12
  const anchor = shownMenu?.anchor
  const menuLeft = anchor ? Math.max(8, Math.min(anchor.x - MENU_W - 6, width - MENU_W - 8)) : 0
  const menuTop = anchor ? Math.max(insets.top + 8, Math.min(anchor.y - 10, height - MENU_H - 16)) : 0

  const menuScale = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] })
  const renameScale = renameAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] })
  const confirmScale = confirmAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] })

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>

      <Animated.View
        style={[
          s.panel,
          { width: panelWidth, paddingTop: insets.top + 6, paddingBottom: insets.bottom + 10, transform: [{ translateX }] },
        ]}
      >
        <View style={s.header}>
          <View style={s.brandRow}>
            <Image source={require('../../assets/logo.png')} style={s.brandLogo} />
            <Text style={s.brand}>Hermes</Text>
          </View>
          <Pressable style={s.iconBtn} onPress={onClose} hitSlop={10} accessibilityLabel="Close menu">
            <Ionicons name="close" size={20} color={C.textDim} />
          </Pressable>
        </View>

        <View>
          {nav.map((item) => (
            <Pressable
              key={item.key}
              style={({ pressed }) => [s.navRow, pressed && s.rowPressed]}
              onPress={() => {
                onNav(item.key)
                onClose()
              }}
              accessibilityLabel={item.label}
            >
              <Ionicons name={item.icon} size={20} color={C.text} />
              <Text style={s.navLabel}>{item.label}</Text>
              {item.badge ? (
                <View style={s.badge}>
                  <Text style={s.badgeText}>{item.badge > 9 ? '9+' : item.badge}</Text>
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>

        {recent.length > 0 ? (
          <>
            <View style={s.searchWrap}>
              <Ionicons name="search" size={14} color={C.textFaint} />
              <TextInput
                style={s.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search chats…"
                placeholderTextColor={C.textFaint}
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel="Search chats"
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
                  <Ionicons name="close" size={14} color={C.textFaint} />
                </Pressable>
              ) : null}
            </View>
            <SectionList<RecentChat, Section>
              sections={sections}
              keyExtractor={(c) => c.id}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: c }) => {
                const isPinned = pinned.includes(c.id)
                return (
                  <Pressable
                    onPress={() => {
                      onOpenChat(c.id)
                      onClose()
                    }}
                    onLongPress={(e) => openMenu(c, e)}
                    delayLongPress={350}
                    style={({ pressed }) => [s.recentRow, pressed && s.recentRowPressed]}
                    accessibilityLabel={`Open ${c.title}`}
                  >
                    {c.busy ? <View style={s.busyDot} /> : null}
                    <Text style={[s.recentTitle, c.active && s.recentTitleActive]} numberOfLines={1}>
                      {c.title}
                    </Text>
                    {isPinned ? <Ionicons name="pin" size={11} color={C.textFaint} /> : null}
                    {c.unread ? <View style={s.unreadDot} /> : null}
                    <Pressable
                      style={s.rowMenu}
                      hitSlop={6}
                      onPress={(e) => openMenu(c, e)}
                      accessibilityLabel={`Options for ${c.title}`}
                    >
                      <Ionicons name="ellipsis-horizontal" size={15} color={C.textFaint} />
                    </Pressable>
                  </Pressable>
                )
              }}
              renderSectionHeader={({ section }) => {
                if (!section.label) return null
                if (section.collapsible) {
                  return (
                    <Pressable
                      style={s.sectionLabelRow}
                      onPress={() => setArchOpen((v) => !v)}
                      accessibilityLabel={`${archOpen ? 'Collapse' : 'Expand'} archived chats`}
                    >
                      <Text style={s.sectionLabel}>{section.label} ({section.count ?? 0})</Text>
                      <Ionicons name={archOpen ? 'chevron-up' : 'chevron-down'} size={12} color={C.textFaint} />
                    </Pressable>
                  )
                }
                return (
                  <View style={s.sectionLabelRow}>
                    <Text style={s.sectionLabel}>{section.label}</Text>
                  </View>
                )
              }}
              renderSectionFooter={() => <View style={s.sectionGap} />}
              ListEmptyComponent={
                searching ? <Text style={s.noMatch}>No chats matching “{query.trim()}”</Text> : null
              }
            />
          </>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        {footer}

        {/* Primary action, pinned like ChatGPT's blue button. */}
        <Pressable
          style={({ pressed }) => [s.newChat, pressed && { opacity: 0.85 }]}
          onPress={() => {
            onNewChat()
            onClose()
          }}
          accessibilityLabel="New chat"
        >
          <Ionicons name="add" size={20} color="#FFFFFF" />
          <Text style={s.newChatText}>New chat</Text>
        </Pressable>
      </Animated.View>

      {/* ── Per-chat popover, anchored where the row was pressed ──────────── */}
      {shownMenu ? (
        <View style={s.overlay} pointerEvents="box-none">
          <Animated.View style={[StyleSheet.absoluteFill, s.menuScrim, { opacity: menuAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel="Close menu" />
          </Animated.View>
          <Animated.View
            style={[s.menuCard, { left: menuLeft, top: menuTop, opacity: menuAnim, transform: [{ scale: menuScale }] }]}
          >
            <MenuRow
              icon={menuPinned ? 'pin-outline' : 'pin'}
              label={menuPinned ? 'Unpin' : 'Pin'}
              onPress={() => {
                onPinToggle?.(shownMenu.chat.id)
                closeDialogs()
              }}
            />
            <MenuRow icon="pencil-outline" label="Rename" onPress={() => openRename(shownMenu.chat)} />
            <MenuRow
              icon="archive-outline"
              label={menuArchived ? 'Unarchive' : 'Archive'}
              onPress={() => {
                onArchiveToggle?.(shownMenu.chat.id)
                closeDialogs()
              }}
            />
            <MenuRow icon="trash-outline" label="Delete" danger onPress={() => openDelete(shownMenu.chat)} />
          </Animated.View>
        </View>
      ) : null}

      {/* ── Rename dialog ─────────────────────────────────────────────────── */}
      {shownRename ? (
        <View style={s.overlay}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: renameAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel="Cancel rename" />
          </Animated.View>
          <Animated.View style={[s.dialogCard, { opacity: renameAnim, transform: [{ scale: renameScale }] }]}>
            <Text style={s.dialogTitle}>Rename chat</Text>
            <TextInput
              style={s.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              selectTextOnFocus
              maxLength={200}
              onSubmitEditing={() => void saveRename()}
              accessibilityLabel="Chat name"
            />
            {dialogError ? <Text style={s.dialogError}>{dialogError}</Text> : null}
            <View style={s.dialogButtons}>
              <Pressable style={[s.dialogBtn, dialogBusy && s.dialogBtnBusy]} onPress={closeDialogs} disabled={dialogBusy}>
                <Text style={s.dialogBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.dialogBtnPrimary, (dialogBusy || !renameText.trim()) && s.dialogBtnBusy]}
                onPress={() => void saveRename()}
                disabled={dialogBusy || !renameText.trim()}
              >
                <Text style={s.dialogBtnPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      ) : null}

      {/* ── Delete confirmation ───────────────────────────────────────────── */}
      {shownConfirm ? (
        <View style={s.overlay}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: confirmAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel="Cancel delete" />
          </Animated.View>
          <Animated.View style={[s.dialogCard, { opacity: confirmAnim, transform: [{ scale: confirmScale }] }]}>
            <Text style={s.dialogTitle}>Delete this chat?</Text>
            <Text style={s.dialogBody}>
              “{shownConfirm.title}” is permanently removed from Hermes.
            </Text>
            {dialogError ? <Text style={s.dialogError}>{dialogError}</Text> : null}
            <View style={s.dialogButtons}>
              <Pressable style={[s.dialogBtn, dialogBusy && s.dialogBtnBusy]} onPress={closeDialogs} disabled={dialogBusy}>
                <Text style={s.dialogBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.dialogBtnDanger, dialogBusy && s.dialogBtnBusy]}
                onPress={() => void runDelete()}
                disabled={dialogBusy}
              >
                <Text style={s.dialogBtnDangerText}>Delete</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      ) : null}
    </View>
  )
}

/** One icon row inside the anchored chat menu. */
function MenuRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  danger?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      style={({ pressed }) => [s.menuRow, pressed && s.menuRowPressed]}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color={danger ? C.red : C.text} />
      <Text style={[s.menuRowLabel, danger && { color: C.red }]}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: C.bgElev,
    borderRightWidth: 1,
    borderRightColor: C.borderSoft,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 4,
  },
  brand: { color: C.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandLogo: { width: 24, height: 18, resizeMode: 'contain' },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    minHeight: 48,
    justifyContent: 'flex-start',
  },
  rowPressed: { backgroundColor: C.bgHover },
  navLabel: { color: C.text, fontSize: 15.5, fontWeight: '500', flex: 1 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: C.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginVertical: 8,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.borderSoft,
  },
  searchInput: { flex: 1, color: C.text, fontSize: 14, paddingVertical: 0, minHeight: 36 },
  // Section headers: the "gaps" between time groups.
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
  },
  sectionLabel: {
    color: C.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionGap: { height: 6 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
    minHeight: 44,
    borderRadius: 10,
  },
  recentRowPressed: { backgroundColor: C.bgHover },
  recentTitle: { flex: 1, color: C.textDim, fontSize: 14.5, fontWeight: '400' },
  recentTitleActive: { color: C.text, fontWeight: '600' },
  busyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.greenSoft },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.accent },
  rowMenu: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noMatch: { color: C.textFaint, fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 },
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.accent,
  },
  newChatText: { color: '#FFFFFF', fontSize: 15.5, fontWeight: '700' },

  // Anchored chat menu + dialogs — in-app overlays (Alert.alert is a no-op on
  // web). The container carries no background: each overlay fades its own
  // scrim so the whole thing can animate in and out.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  menuScrim: { backgroundColor: 'rgba(0,0,0,0.28)' },
  menuCard: {
    position: 'absolute',
    width: 240,
    borderRadius: 12,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.borderSoft,
    paddingVertical: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  menuRowPressed: { backgroundColor: C.bgHover },
  menuRowLabel: { color: C.text, fontSize: 15.5, flex: 1 },

  dialogCard: {
    width: '86%',
    maxWidth: 400,
    alignSelf: 'center',
    backgroundColor: C.bgCard,
    borderRadius: 16,
    padding: 18,
    gap: 12,
  },
  dialogTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  dialogBody: { color: C.textDim, fontSize: 13.5 },
  dialogError: { color: C.red, fontSize: 12.5 },
  renameInput: {
    backgroundColor: C.inputBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.borderSoft,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  dialogBtn: {
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: C.bgHover,
  },
  dialogBtnBusy: { opacity: 0.5 },
  dialogBtnText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  dialogBtnPrimary: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: C.accent,
  },
  dialogBtnPrimaryText: { color: '#FFFFFF', fontSize: 14.5, fontWeight: '700' },
  dialogBtnDanger: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: C.red,
  },
  dialogBtnDangerText: { color: '#FFFFFF', fontSize: 14.5, fontWeight: '700' },
})
