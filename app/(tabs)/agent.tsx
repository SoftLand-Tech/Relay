import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { rpc, isConnected as isConnectedAtom, retryNow } from '../../src/lib/gateway'
import { activeSession } from '../../src/lib/chat'
import { log } from '../../src/lib/log'
import { C } from '../../src/lib/theme'
import { ScreenShell } from '../../src/components/ScreenShell'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

interface ProviderOption {
  slug: string
  name: string
  is_current?: boolean
  models?: string[]
  total_models?: number
  authenticated?: boolean
}

export default function Controls() {
  const online = useStore(isConnectedAtom)
  const sid = useStore(activeSession)
  const [effort, setEffort] = useState<string>('')
  const [showReasoning, setShowReasoning] = useState(true)
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [openProvider, setOpenProvider] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!online) return
    try {
      // The config vocabulary is a small fixed set — `agent.reasoning_effort`
      // is NOT a valid key (4002). The right one is `reasoning`.
      const r = await rpc<{ value?: string; display?: string }>('config.get', { key: 'reasoning' })
      if (r?.value) setEffort(String(r.value))
      if (r?.display) setShowReasoning(r.display !== 'hide')
    } catch (err) {
      log('warn', 'agent', `config.get reasoning failed: ${String(err)}`)
    }
    try {
      const res = await rpc<{ providers?: ProviderOption[]; model?: string; provider?: string }>('model.options', {})
      if (res?.model) setModel(String(res.model))
      if (res?.provider) setProvider(String(res.provider))
      if (Array.isArray(res?.providers)) {
        setProviders(res.providers.filter((p) => Array.isArray(p.models) && p.models.length > 0))
      }
    } catch (err) {
      log('warn', 'agent', `model.options failed: ${String(err)}`)
    }
  }, [online])

  useEffect(() => {
    setLoading(true)
    void refresh().finally(() => setLoading(false))
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

  const pickModel = async (p: ProviderOption, m: string) => {
    const prevModel = model
    const prevProvider = provider
    setModel(m)
    setProvider(p.slug)
    setSaving(`model:${m}`)
    setOpenProvider(null)
    try {
      // `model` is the valid setter key — `model.default` is not in the table.
      await rpc('config.set', { key: 'model', value: m, ...(sid ? { session_id: sid } : {}) })
      await refresh()
    } catch (e) {
      setModel(prevModel)
      setProvider(prevProvider)
      Alert.alert('Failed to save model', e instanceof Error ? e.message : '')
    } finally {
      setSaving(null)
    }
  }

  const toggleReasoning = async (next: boolean) => {
    const prev = showReasoning
    setShowReasoning(next)
    try {
      // `config.set reasoning show|hide` is the documented toggle verb.
      await rpc('config.set', { key: 'reasoning', value: next ? 'show' : 'hide' })
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

      <View>
        <View style={s.sectionRow}>
          <Text style={s.section}>MODEL</Text>
          {loading ? <ActivityIndicator color={C.accent} size="small" /> : null}
        </View>
        <View style={s.modelList}>
          {providers.length === 0 && !loading ? (
            <View style={s.modelRow}>
              <Text style={s.modelText}>{model || 'default'}</Text>
              <Text style={s.badge}>ACTIVE</Text>
            </View>
          ) : null}

          {providers.map((p) => {
            const isOpen = openProvider === p.slug
            const isCurrent = p.slug === provider
            return (
              <View key={p.slug}>
                <Pressable
                  style={[s.modelRow, isCurrent && s.modelRowOn]}
                  onPress={() => setOpenProvider(isOpen ? null : p.slug)}
                  accessibilityLabel={`${p.name} provider`}
                  accessibilityState={{ expanded: isOpen }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[s.modelText, isCurrent && s.modelTextOn]}>{p.name}</Text>
                    {!p.authenticated ? <Text style={s.warnText}>not signed in</Text> : null}
                  </View>
                  {isCurrent ? <Text style={s.badge}>ACTIVE</Text> : null}
                  <IoniconsChevron open={isOpen} />
                </Pressable>
                {isOpen
                  ? (p.models ?? []).slice(0, 40).map((m) => (
                      <Pressable
                        key={m}
                        style={s.subRow}
                        onPress={() => void pickModel(p, m)}
                        accessibilityLabel={`Use model ${m}`}
                      >
                        <Text style={[s.subText, m === model && isCurrent && s.subTextOn]}>{m}</Text>
                        {saving === `model:${m}` ? <ActivityIndicator color={C.accent} size="small" /> : null}
                      </Pressable>
                    ))
                  : null}
              </View>
            )
          })}
        </View>
        <Text style={s.hint}>
          Served by your gateway config. Switch provider to see its models.
        </Text>
      </View>
    </ScrollView>
  )

  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell title="Controls" showBrand>
        {body}
      </ScreenShell>
    </SafeAreaView>
  )
}

function IoniconsChevron({ open }: { open: boolean }) {
  return (
    <Text style={s.chevron}>{open ? '▾' : '▸'}</Text>
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
  effortRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  effortPill: { paddingHorizontal: 15, paddingVertical: 11, borderRadius: 22, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, minHeight: 44, justifyContent: 'center' },
  effortOn: { backgroundColor: C.accent, borderColor: C.accent },
  effortText: { color: C.textDim, fontSize: 13.5, fontWeight: '600' },
  effortTextOn: { color: '#FFFFFF', fontWeight: '800' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, minHeight: 56 },
  toggleLabel: { color: C.text, fontSize: 14.5, flex: 1 },
  hint: { color: C.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
  modelList: { backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border, minHeight: 52 },
  modelRowOn: { backgroundColor: 'rgba(46,125,91,0.18)' },
  modelText: { color: C.text, fontSize: 14.5 },
  modelTextOn: { color: C.greenSoft, fontWeight: '700' },
  warnText: { color: C.red, fontSize: 11, marginTop: 2 },
  subRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 30, paddingRight: 16, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.border, minHeight: 46, backgroundColor: C.bg },
  subText: { color: C.textDim, fontSize: 13.5, flex: 1 },
  subTextOn: { color: C.accent, fontWeight: '700' },
  chevron: { color: C.textDim, fontSize: 14, width: 16, textAlign: 'right' },
  badge: { color: C.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
})
