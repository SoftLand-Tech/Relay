import React, { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Alert, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import * as Clipboard from 'expo-clipboard'
import { router } from 'expo-router'
import { connConfig, connectionState, gatewayError, disconnect, clearConfig, rpc, retryNow, redactedUrl, connect } from '../../src/lib/gateway'
import { newChat, activeSession, messages } from '../../src/lib/chat'
import { diagLog, logText } from '../../src/lib/log'
import { normalizeHost } from '../../src/lib/gateway'
import {
  notificationsEnabled, expoPushToken, notificationPermission, setNotificationsEnabled,
  ensureNotificationPermission, fetchPushToken, sendTestNotification, easProjectId,
  remotePushSupported, remotePushBlockedReason,
} from '../../src/lib/push'
import { C } from '../../src/lib/theme'
import { ScreenShell } from '../../src/components/ScreenShell'

export default function Settings() {
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <SettingsInner />
    </SafeAreaView>
  )
}

function SettingsInner() {
  const cfg = useStore(connConfig)
  const state = useStore(connectionState)
  const err = useStore(gatewayError)
  const logs = useStore(diagLog)
  const sid = useStore(activeSession)
  const msgs = useStore(messages)
  const notifOn = useStore(notificationsEnabled)
  const pushTok = useStore(expoPushToken)
  const perm = useStore(notificationPermission)
  const [editing, setEditing] = useState(false)
  const [host, setHost] = useState('')
  const [tls, setTls] = useState(false)

  const copyDiagnostics = async () => {
    const text = [
      `Hermes Pocket v1.0`,
      `Server: ${cfg ? redactedUrl(cfg) : '—'}`,
      `State: ${state}${err ? ` (${err.slice(0, 200)})` : ''}`,
      `Session: ${sid ?? '—'} · messages: ${msgs.length}`,
      ``,
      `--- log ---`,
      logText().slice(-4000),
    ].join('\n')
    await Clipboard.setStringAsync(text)
    Alert.alert('Copied', 'Diagnostics copied to clipboard.')
  }

  const exportTranscript = async () => {
    const text = msgs.map((m) => `[${new Date(m.ts).toLocaleString()}] ${m.role}: ${m.text}`).join('\n\n')
    if (!text) { Alert.alert('Empty', 'No messages to export.'); return }
    await Clipboard.setStringAsync(text.slice(0, 50000))
    Alert.alert('Copied', 'Transcript copied to clipboard.')
  }

  const saveHost = async () => {
    try {
      const h = normalizeHost(host)
      if (!cfg) { Alert.alert('No connection', 'Connect first.'); return }
      await connect({ host: h, token: cfg.token, tls })
      setEditing(false)
    } catch (e) { Alert.alert('Invalid', e instanceof Error ? e.message : '') }
  }

  return (
    <ScreenShell title="Settings" showBrand>
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <View style={s.card}>
        <Text style={s.label}>CONNECTION</Text>
        <Text style={s.value}>{cfg?.host ?? '—'}</Text>
        <Text style={s.sub}>State: {state}{err ? ` (${err.slice(0, 200)})` : ''}</Text>
        <Text style={s.sub}>Transport: {cfg?.tls ? 'WSS' : 'WS (local only recommended)'}</Text>
        <Text style={s.sub}>Session: {sid ? `${sid.slice(0, 12)}…` : '—'} · {msgs.length} msgs</Text>
      </View>

      {!editing ? (
        <Pressable style={s.action} onPress={() => { setHost(cfg?.host ?? ''); setTls(!!cfg?.tls); setEditing(true) }}>
          <Text style={s.actionText}>Edit server address</Text>
        </Pressable>
      ) : (
        <View style={s.card}>
          <Text style={s.label}>SERVER</Text>
          <TextInput style={s.input} value={host} onChangeText={setHost} placeholder="192.168.1.10:9999" placeholderTextColor={C.textFaint} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Server address" />
          <Pressable style={s.tlsRow} onPress={() => setTls(!tls)}>
            <View style={[s.checkbox, tls && s.checkboxOn]} />
            <Text style={s.tlsText}>Use TLS (wss)</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable style={[s.action, { flex: 1 }]} onPress={saveHost}><Text style={s.actionText}>Save & reconnect</Text></Pressable>
            <Pressable style={[s.action, { flex: 1 }]} onPress={() => setEditing(false)}><Text style={[s.actionText, { color: C.textDim }]}>Cancel</Text></Pressable>
          </View>
        </View>
      )}

      <Pressable style={s.action} onPress={() => { void retryNow().catch((e) => Alert.alert('Retry failed', String(e))) }}>
        <Text style={s.actionText}>Reconnect now</Text>
      </Pressable>

      <Pressable style={s.action} onPress={() => { disconnect() }}>
        <Text style={s.actionText}>Disconnect</Text>
      </Pressable>

      <Pressable style={[s.action, s.danger]} onPress={() => {
        Alert.alert('Forget server?', 'Removes host and token from this device.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Forget', style: 'destructive', onPress: async () => { disconnect(); await clearConfig(); router.replace('/') } },
        ])
      }}>
        <Text style={[s.actionText, { color: C.red }]}>Forget server (wipe credentials)</Text>
      </Pressable>

      <Pressable style={s.action} onPress={() => {
        Alert.alert('New chat?', 'Clears the current transcript and starts a fresh session.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Start', onPress: () => { void newChat().catch((e) => Alert.alert('Failed', String(e))) } },
        ])
      }}>
        <Text style={s.actionText}>Start new chat session</Text>
      </Pressable>

      <Pressable style={s.action} onPress={exportTranscript}>
        <Text style={s.actionText}>Export transcript (copy)</Text>
      </Pressable>

      <View style={s.card}>
        <Text style={s.label}>NOTIFICATIONS</Text>
        <Pressable style={s.tlsRow} onPress={() => { void setNotificationsEnabled(!notifOn) }} accessibilityLabel="Toggle notifications">
          <View style={[s.checkbox, notifOn && s.checkboxOn]} />
          <Text style={s.tlsText}>Buzz for approvals, questions & replies</Text>
        </Pressable>
        <Text style={s.sub}>Permission: {perm}</Text>
        <Text style={s.sub}>Push token: {pushTok ? `${pushTok.slice(0, 22)}…` : 'none'}</Text>
        {remotePushBlockedReason ? (
          <Text style={s.warn}>{remotePushBlockedReason}</Text>
        ) : !easProjectId() ? (
          <Text style={s.sub}>Remote push needs a linked EAS project.{'\n'}Run `npx eas init` in hermes-mobile and rebuild — local alerts work without it.</Text>
        ) : null}
      </View>

      <Pressable style={s.action} onPress={() => { void ensureNotificationPermission().catch(() => {}) }}>
        <Text style={s.actionText}>Enable notifications</Text>
      </Pressable>

      <Pressable style={s.action} onPress={() => { void sendTestNotification().catch((e) => Alert.alert('Failed', String(e))) }}>
        <Text style={s.actionText}>Send test notification</Text>
      </Pressable>

      <Pressable
        style={[s.action, !remotePushSupported && s.actionDisabled]}
        disabled={!remotePushSupported}
        onPress={async () => {
          try {
            const t = await fetchPushToken()
            await Clipboard.setStringAsync(t)
            Alert.alert('Push token ready', 'Copied. Paste it into hermes-push-watch.py --push-token so approvals reach you when the app is closed.')
          } catch (e) { Alert.alert('Push token failed', e instanceof Error ? e.message : '') }
        }}
      >
        <Text style={s.actionText}>Get push token (for PC watcher)</Text>
      </Pressable>

      <Pressable style={s.action} onPress={copyDiagnostics}>
        <Text style={s.actionText}>Copy diagnostics ({logs.length} log lines)</Text>
      </Pressable>

      <Pressable style={s.action} onPress={async () => {
        try {
          const r = await rpc<unknown>('gateway.ping', {}, 10_000)
          Alert.alert('gateway.ping OK', JSON.stringify(r).slice(0, 300))
        } catch (e) { Alert.alert('Ping failed', String(e)) }
      }}>
        <Text style={s.actionText}>Test RPC (gateway.ping)</Text>
      </Pressable>

      <View style={s.card}>
        <Text style={s.label}>ABOUT</Text>
        <Text style={s.sub}>Hermes Pocket v1.0 — mobile client for your self-hosted Hermes gateway (same JSON-RPC protocol). Pair from your PC with scripts/hermes-pair.sh.</Text>
      </View>
    </ScrollView>
    </ScreenShell>
  )
}

const s = StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  card: { backgroundColor: C.bgCard, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.border },
  label: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 2, marginBottom: 8 },
  value: { color: C.text, fontSize: 15.5, fontWeight: '700' },
  sub: { color: C.textDim, fontSize: 13, lineHeight: 19, marginTop: 4 },
  action: { backgroundColor: C.inputBg, borderRadius: 12, paddingVertical: 15, paddingHorizontal: 16, minHeight: 52, justifyContent: 'center' },
  actionDisabled: { opacity: 0.45 },
  warn: { color: C.red, fontSize: 12, lineHeight: 17, marginTop: 6 },
  danger: { borderWidth: 1, borderColor: C.red },
  actionText: { color: C.text, fontSize: 15, fontWeight: '600' },
  input: { backgroundColor: C.inputBg, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border },
  tlsRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, minHeight: 44 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: C.textFaint, marginRight: 10 },
  checkboxOn: { backgroundColor: C.accent, borderColor: C.accent },
  tlsText: { color: C.textDim, fontSize: 13.5 },
})
