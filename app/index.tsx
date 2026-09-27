import React, { useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, ActivityIndicator, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { connect, normalizeHost } from '../src/lib/gateway'
import { parseConnectUrl } from '../src/lib/pairing'
import { C } from '../src/lib/theme'

export default function Onboarding() {
  const [host, setHost] = useState('')
  const [token, setToken] = useState('')
  const [tls, setTls] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [pairingCode, setPairingCode] = useState('')
  const [permission, requestPermission] = useCameraPermissions()
  const scanned = useRef(false)

  const doConnect = async (override?: { host: string; token: string; tls: boolean }) => {
    const h = (override?.host ?? host).trim()
    const t = (override?.token ?? token).trim()
    const useTls = override?.tls ?? tls
    if (!h || !t) {
      setError('Enter the server address and token — or scan the QR from your PC.')
      return
    }
    try { normalizeHost(h) } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid server address.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await connect({ host: h, token: t, tls: useTls })
      router.replace('/(tabs)/chat')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check host and token')
    } finally {
      setBusy(false)
    }
  }

  const onScanned = (data: string) => {
    if (scanned.current || !data) return
    scanned.current = true
    try {
      const p = parseConnectUrl(data)
      setHost(p.host)
      setToken(p.token)
      setTls(p.tls)
      setShowScanner(false)
      scanned.current = false
      void doConnect(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bad QR code')
      setShowScanner(false)
      scanned.current = false
    }
  }

  const applyPairingCode = () => {
    if (!pairingCode.trim()) return
    try {
      const p = parseConnectUrl(pairingCode.trim())
      setHost(p.host)
      setToken(p.token)
      setTls(p.tls)
      setPairingCode('')
      void doConnect(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bad pairing code')
    }
  }

  const openScanner = async () => {
    if (!permission?.granted) {
      const r = await requestPermission()
      if (!r.granted) { setError('Camera permission is needed to scan the QR.'); return }
    }
    scanned.current = false
    setShowScanner(true)
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.kicker}>SELF-HOSTED AGENT</Text>
        <Text style={s.title}>Hermes{'\n'}Pocket</Text>
        <Text style={s.sub}>Your agent, in your pocket — streaming, approvals, sessions.</Text>

        <Pressable style={s.scanBtn} onPress={openScanner} accessibilityRole="button" accessibilityLabel="Scan pairing QR">
          <Text style={s.scanText}>Scan pairing QR from your PC</Text>
        </Pressable>

        <View style={s.card}>
          <Text style={s.label}>SERVER</Text>
          <TextInput
            style={s.input}
            value={host}
            onChangeText={setHost}
            placeholder="192.168.1.10:9999"
            placeholderTextColor={C.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Server address"
          />
          <Text style={s.help}>On your PC run: ./scripts/hermes-pair.sh — it prints host, token and a QR.</Text>
          <Pressable style={s.tlsRow} onPress={() => setTls(!tls)} accessibilityRole="checkbox" accessibilityLabel="Use TLS">
            <View style={[s.checkbox, tls && s.checkboxOn]} />
            <Text style={s.tlsText}>Use HTTPS/WSS (Tailscale / public host)</Text>
          </Pressable>
          <Text style={s.label}>TOKEN</Text>
          <View style={s.tokenRow}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              value={token}
              onChangeText={setToken}
              placeholder="Paste token from pairing script"
              placeholderTextColor={C.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showToken}
              accessibilityLabel="Token"
            />
            <Pressable style={s.showBtn} onPress={() => setShowToken(!showToken)} accessibilityLabel={showToken ? 'Hide token' : 'Show token'}>
              <Text style={s.showText}>{showToken ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Pressable style={[s.btn, busy && s.btnBusy]} onPress={() => void doConnect()} disabled={busy} accessibilityLabel="Connect">
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.btnText}>Connect</Text>}
          </Pressable>
        </View>

        <View style={s.card}>
          <Text style={s.label}>OR PASTE PAIRING LINK</Text>
          <TextInput
            style={s.input}
            value={pairingCode}
            onChangeText={setPairingCode}
            placeholder="hermes://connect?host=…&token=…"
            placeholderTextColor={C.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Pairing link"
          />
          <Pressable style={s.secondaryBtn} onPress={applyPairingCode} accessibilityLabel="Use pairing link">
            <Text style={s.secondaryText}>Use pairing link</Text>
          </Pressable>
        </View>
      </ScrollView>

      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <View style={s.scannerRoot}>
          <CameraView
            style={s.scanner}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(r) => onScanned(r.data)}
          />
          <View style={s.scannerFooter}>
            <Text style={s.scannerHint}>Point at the QR printed by hermes-pair.sh</Text>
            <Pressable style={s.secondaryBtn} onPress={() => setShowScanner(false)}>
              <Text style={s.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingBottom: 40 },
  kicker: { color: C.accent, fontSize: 11, fontWeight: '700', letterSpacing: 2.5, marginBottom: 10, marginTop: 20 },
  title: { color: '#FFFFFF', fontSize: 46, fontWeight: '800', lineHeight: 52, marginBottom: 10 },
  sub: { color: C.textDim, fontSize: 15, marginBottom: 20, lineHeight: 21 },
  scanBtn: { backgroundColor: C.inputBg, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginBottom: 14, borderWidth: 1, borderColor: C.border, minHeight: 48 },
  scanText: { color: C.text, fontSize: 15, fontWeight: '700' },
  card: { backgroundColor: C.bgCard, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  label: { color: C.textFaint, fontSize: 10.5, fontWeight: '700', letterSpacing: 2, marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: C.inputBg, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, color: C.text, fontSize: 15, minHeight: 48 },
  help: { color: C.textFaint, fontSize: 12, marginTop: 6, lineHeight: 17 },
  tlsRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, minHeight: 44 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: C.textFaint, marginRight: 10 },
  checkboxOn: { backgroundColor: C.accent, borderColor: C.accent },
  tlsText: { color: C.textDim, fontSize: 13.5, flexShrink: 1 },
  tokenRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  showBtn: { paddingHorizontal: 14, paddingVertical: 13, borderRadius: 10, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, minHeight: 48, justifyContent: 'center' },
  showText: { color: C.textDim, fontSize: 13, fontWeight: '700' },
  error: { color: C.red, fontSize: 13, marginTop: 10, lineHeight: 18 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 18, minHeight: 52, justifyContent: 'center' },
  btnBusy: { opacity: 0.7 },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  secondaryBtn: { backgroundColor: C.inputBg, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: C.border, minHeight: 48, justifyContent: 'center' },
  secondaryText: { color: C.text, fontSize: 14, fontWeight: '700' },
  scannerRoot: { flex: 1, backgroundColor: '#000' },
  scanner: { flex: 1 },
  scannerFooter: { padding: 20, backgroundColor: '#000', gap: 10 },
  scannerHint: { color: '#fff', textAlign: 'center', fontSize: 14 },
})
