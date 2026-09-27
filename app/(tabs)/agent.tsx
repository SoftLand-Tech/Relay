import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { rpc, isConnected as isConnectedAtom, retryNow } from '../../src/lib/gateway'
import { activeSession, ensureSession } from '../../src/lib/chat'
import { liveModel, liveProvider, fetchModelOptions } from '../../src/lib/modelState'
import { log } from '../../src/lib/log'
import { C } from '../../src/lib/theme'
import { ScreenShell } from '../../src/components/ScreenShell'
import { ModelPickerSheet } from '../../src/components/ModelPickerSheet'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export default function Controls() {
  const online = useStore(isConnectedAtom)
  const sid = useStore(activeSession)
  const model = useStore(liveModel)
  const provider = useStore(liveProvider)
  const [effort, setEffort] = useState<string>('')
  const [showReasoning, setShowReasoning] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const refresh = React.useCallback(async () => {
    if (!online) return
    try {
      // The config vocabulary is a small fixed set — `agent.reasoning_effort`
      // is NOT a valid key (4002). The right one is `reasoning`.
      const r = await rpc<{ value?: string; display?: string }>('config.get', { key: 'reasoning', ...(sid ? { session_id: sid } : {}) })
      if (r?.value) setEffort(String(r.value))
      if (r?.display) setShowReasoning(r.display !== 'hide')
    } catch (err) {
      log('warn', 'agent', `config.get reasoning failed: ${String(err)}`)
    }
    try {
      // Fills liveModel/liveProvider AND caches the picker inventory.
      if (sid) await fetchModelOptions(sid).catch(() => {})
    } catch (err) {
      log('warn', 'agent', `model.options failed: ${String(err)}`)
    }
  }, [online, sid])

  useEffect(() => {
    setLoading(true)
    void (async () => {
      try {
        // The picker needs a live session to scope config.set / model.options.
        await ensureSession()
        await refresh()
      } catch {
        /* offline banner path */
      }
    })().finally(() => setLoading(false))
  }, [refresh])

  const setAndSave = async (v: string) => {
    const prev = effort
    setEffort(v)
    setSaving(`effort:${v}`)
    try {
      // `config.set` writes session-scoped when a session_id is supplied.
      await rpc('config.set', { key: 'reasoning', value: v, ...(sid ? { session_id: sid } : {}) })
      await refresh()
    } catch (e) {
      setEffort(prev)
      Alert.alert('Failed to save', e instanceof Error ? e.message : '')
    } finally {
      setSaving(null)
    }
  }

  const toggleReasoning = async (next: boolean) => {
    const prev = showReasoning
    setShowReasoning(next)
    try {
      // `config.set reasoning show|hide` is the documented toggle verb.
      await rpc('config.set', { key: 'reasoning', value: next ? 'show' : 'hide', ...(sid ? { session_id: sid } : {}) })
      await refresh()
    } catch (e) {
      setShowReasoning(prev)
      Alert.alert('Failed to save', e instanceof Error ? e.message : '')
    }
  }

  const body = !online ? (
    <View style={s.root}>
      <Text style={s.offline}>Not connected</Text>
      <Pressable style={s.retry} onPress={() => { void retryNow().catch(() => {}) }}>
        <Text style={s.retryText}>Reconnect</Text>
      </Pressable>
    </View>
  ) : (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 40 }}>
      <View>
        <View style={s.sectionRow}>
          <Text style={s.section}>MODEL</Text>
          {loading ? <ActivityIndicator color={C.accent} size="small" /> : null}
        </View>
        <Pressable
          style={s.modelCard}
          onPress={() => setPickerOpen(true)}
          accessibilityLabel={`Current model ${model || 'default'}. Tap to change`}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.modelName} numberOfLines={1}>{model || 'default'}</Text>
            <Text style={s.modelSub}>
              {provider ? `${provider} · ` : ''}tap to pick a provider, model and scope
            </Text>
          </View>
          <View style={s.modelChevron}>
            <Ionicons name="options-outline" size={16} color={C.accent} />
            <Text style={s.modelChevronText}>CHANGE</Text>
          </View>
        </Pressable>
        <Text style={s.hint}>
          “This chat” switches the conversation now; “Everywhere” saves the new
          default on the server; “Next reply only” tries it for one turn.
        </Text>
      </View>

      <View>
        <View style={s.sectionRow}>
          <Text style={s.section}>REASONING EFFORT</Text>
          {saving?.startsWith('effort:') ? <ActivityIndicator color={C.accent} size="small" /> : null}
        </View>
        <View style={s.effortRow}>
          {EFFORTS.map((e) => (
            <Pressable
              key={e}
              style={[s.effortPill, effort === e && s.effortOn]}
              onPress={() => void setAndSave(e)}
              accessibilityLabel={`Reasoning effort ${e}`}
              accessibilityState={{ selected: effort === e }}
              hitSlop={4}
            >
              <Text style={[s.effortText, effort === e && s.effortTextOn]}>{e}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.hint}>How long the model thinks before answering.</Text>
      </View>

      <View>
        <Text style={s.section}>SHOW REASONING</Text>
        <View style={s.toggleRow}>
          <Text style={s.toggleLabel}>Show thinking in the chat</Text>
          <Switch
            value={showReasoning}
            onValueChange={(v) => void toggleReasoning(v)}
            trackColor={{ true: C.accent, false: C.border }}
            accessibilityLabel="Show reasoning"
          />
        </View>
      </View>
    </ScrollView>
  )

  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell title="Models" showBrand>
        {body}
      </ScreenShell>
      <ModelPickerSheet open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  offline: { color: C.textDim, textAlign: 'center', marginTop: 80, fontSize: 15 },
  retry: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, marginHorizontal: 40, marginTop: 16, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  retryText: { color: '#FFFFFF', fontWeight: '800' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginBottom: 10 },
  modelCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 15, paddingVertical: 14, minHeight: 68,
  },
  modelName: { color: C.text, fontSize: 16, fontWeight: '700' },
  modelSub: { color: C.textFaint, fontSize: 12, marginTop: 3 },
  modelChevron: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  modelChevronText: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  effortRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  effortPill: { paddingHorizontal: 15, paddingVertical: 11, borderRadius: 22, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, minHeight: 44, justifyContent: 'center' },
  effortOn: { backgroundColor: C.accent, borderColor: C.accent },
  effortText: { color: C.textDim, fontSize: 13.5, fontWeight: '600' },
  effortTextOn: { color: '#FFFFFF', fontWeight: '800' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, minHeight: 56 },
  toggleLabel: { color: C.text, fontSize: 14.5, flex: 1 },
  hint: { color: C.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
})
