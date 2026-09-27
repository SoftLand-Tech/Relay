import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Animated, ScrollView, useWindowDimensions } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
  /** Unread marker — a question is waiting on this conversation. */
  unread?: boolean
  busy?: boolean
  active?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  onOpen?: () => void
  nav: NavItem[]
  recent: RecentChat[]
  onNav: (key: string) => void
  onNewChat: () => void
  onOpenChat: (id: string) => void
  footer?: React.ReactNode
}

/**
 * ChatGPT-style slide-in sidebar.
 *
 * Implemented as an overlay rather than a Drawer navigator: the app already
 * routes through expo-router tabs, and an overlay keeps that intact while
 * giving the same "drawer slides over the conversation" behaviour.
 */
export function Sidebar({ open, onClose, onOpen, nav, recent, onNav, onNewChat, onOpenChat, footer }: Props) {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const anim = useRef(new Animated.Value(0)).current
  // Stay mounted through the close animation, then unmount.
  const [mounted, setMounted] = useState(open)
  // ChatGPT's panel is ~300dp, capped so it never looks empty on a tablet.
  const panelWidth = Math.min(width * 0.82, 320)

  useEffect(() => {
    if (open) {
      setMounted(true)
      Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start()
      return
    }
    const a = Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true })
    a.start(({ finished }) => {
      if (finished) setMounted(false)
    })
    onOpen?.()
  }, [open, anim])

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] })

  if (!mounted) return null

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
          <Text style={s.brand}>Hermes</Text>
          <Pressable style={s.iconBtn} onPress={onClose} hitSlop={10} accessibilityLabel="Close menu">
            <Ionicons name="close" size={20} color={C.textDim} />
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          showsVerticalScrollIndicator={false}
          onStartShouldSetResponder={() => false}
        >
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

          {recent.length > 0 ? (
            <>
              <View style={s.divider} />
              {recent.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => {
                    onOpenChat(c.id)
                    onClose()
                  }}
                  style={({ pressed }) => [s.recentRow, pressed && s.recentRowPressed]}
                  accessibilityLabel={c.title}
                >
                  {c.busy ? <View style={s.busyDot} /> : null}
                  <Text style={[s.recentTitle, c.active && s.recentTitleActive]} numberOfLines={1}>
                    {c.title}
                  </Text>
                  {c.unread ? <View style={s.unreadDot} /> : null}
                </Pressable>
              ))}
            </>
          ) : null}
        </ScrollView>

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
    </View>
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
  divider: { height: 1, backgroundColor: C.borderSoft, marginVertical: 10, marginHorizontal: 16 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    minHeight: 40,
  },
  recentRowPressed: { backgroundColor: C.bgHover },
  recentTitle: { flex: 1, color: C.textDim, fontSize: 14.5, fontWeight: '400' },
  recentTitleActive: { color: C.text, fontWeight: '600' },
  busyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.greenSoft },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.accent },
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
})
