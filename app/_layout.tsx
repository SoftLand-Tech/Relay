import React, { useEffect, useState } from 'react'
import { Stack, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View, ActivityIndicator, Text, Pressable, StyleSheet, AppState } from 'react-native'
import { useStore } from '@nanostores/react'
import * as Linking from 'expo-linking'
import { initPush, lastNotificationResponse, onNotificationResponse } from '../src/lib/push'
import {
  isConnected as isConnectedAtom, connectionState, connConfig, loadSavedConfig,
  connect, gatewayError, clearConfig, retryNow, disconnect, reconnectAttempt, onForeground, redactedUrl,
} from '../src/lib/gateway'
import { hookChatEvents, loadOutbox } from '../src/lib/chat'
import { parseConnectUrl } from '../src/lib/pairing'
import { C } from '../src/lib/theme'

export default function RootLayout() {
  const state = useStore(connectionState)
  const cfg = useStore(connConfig)
  const err = useStore(gatewayError)
  const attempt = useStore(reconnectAttempt)
  const online = useStore(isConnectedAtom)
  const [linkMsg, setLinkMsg] = useState<string | null>(null)

  useEffect(() => {
    hookChatEvents()
    void loadOutbox()
    void initPush()
    let cancelled = false
    ;(async () => {
      const saved = await loadSavedConfig()
      if (!cancelled && saved) {
        try { await connect(saved) } catch {}
      }
    })()

    const handleUrl = async (url: string | null) => {
      if (!url || !url.startsWith('hermes://')) return
      try {
        const p = parseConnectUrl(url)
        await connect({ host: p.host, token: p.token, tls: p.tls })
        router.replace('/(tabs)/chat')
      } catch (e) {
        setLinkMsg(e instanceof Error ? e.message : 'Bad pairing link')
      }
    }
    void Linking.getInitialURL().then((u) => { if (!cancelled && u) void handleUrl(u) })
    const sub = Linking.addEventListener('url', (ev) => { void handleUrl(ev.url) })

    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') onForeground()
    })

    // Notification tap → chat (covers killed-state launch too).
    // Routed through push.ts so expo-notifications is never in this file's
    // static import graph — see the note in push.ts.
    const goChat = () => {
      try { router.push('/(tabs)/chat') } catch {}
    }
    void lastNotificationResponse().then((r) => {
      if (!cancelled && r) goChat()
    })
    const removeNotifSub = onNotificationResponse(goChat)

    return () => {
      cancelled = true
      sub.remove()
      appSub.remove()
      removeNotifSub?.()
    }
  }, [])

  if (!cfg) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }} />
        {linkMsg ? (
          <View style={s.toast}><Text style={s.toastText}>{linkMsg}</Text></View>
        ) : null}
      </View>
    )
  }

  const failed = !online && (state === 'error' || state === 'closed')
  const connecting = !online && state === 'connecting'

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.bg },
          headerTintColor: C.text,
          contentStyle: { backgroundColor: C.bg },
          headerTitleStyle: { color: C.text, fontWeight: '700' },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
      {!online && state !== 'idle' ? (
        <View style={s.overlay}>
          {failed ? (
            <>
              <Text style={s.errTitle}>Connection failed</Text>
              <Text style={s.errDetail}>
                {cfg ? redactedUrl(cfg) : ''}
                {attempt > 0 ? `\nRetry #${attempt} — auto-retrying…` : ''}
                {err ? `\n${err.slice(0, 300)}` : ''}
              </Text>
              <View style={s.btnRow}>
                <Pressable style={s.btn} onPress={() => { void retryNow().catch(() => {}) }}>
                  <Text style={s.btnText}>Retry</Text>
                </Pressable>
                <Pressable style={s.ghostBtn} onPress={async () => { disconnect(); await clearConfig(); router.replace('/') }}>
                  <Text style={s.ghostText}>Forget</Text>
                </Pressable>
              </View>
            </>
          ) : connecting ? (
            <>
              <ActivityIndicator color={C.accent} size="large" />
              <Text style={s.connecting}>Connecting to your agent…{attempt > 0 ? ` (try ${attempt + 1})` : ''}</Text>
              <Pressable style={s.ghostBtn} onPress={() => { disconnect() }}>
                <Text style={s.ghostText}>Cancel</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
      {linkMsg ? (
        <View style={s.toast}><Text style={s.toastText}>{linkMsg}</Text></View>
      ) : null}
    </View>
  )
}

const s = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center', padding: 30 },
  errTitle: { color: '#E5735F', fontSize: 19, fontWeight: '800', marginBottom: 12 },
  errDetail: { color: C.textDim, fontSize: 13, textAlign: 'center', marginBottom: 24, lineHeight: 19 },
  btnRow: { flexDirection: 'row', gap: 12 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  btnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  ghostBtn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 22, borderWidth: 1, borderColor: C.border, marginTop: 12 },
  ghostText: { color: C.textDim, fontSize: 15, fontWeight: '600' },
  connecting: { color: C.textDim, marginTop: 14, marginBottom: 8 },
  toast: { position: 'absolute', bottom: 40, left: 20, right: 20, backgroundColor: C.bgElev, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border },
  toastText: { color: C.text, fontSize: 13.5, textAlign: 'center' },
})
