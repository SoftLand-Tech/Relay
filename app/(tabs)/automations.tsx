import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { rpc, isConnected as isConnectedAtom } from '../../src/lib/gateway'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C } from '../../src/lib/theme'

interface Job {
  job_id: string
  name?: string
  schedule?: string
  prompt_preview?: string
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  enabled?: boolean
  state?: string | null
}

function when(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  if (diff < 0) return 'due'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`
  return `in ${Math.round(diff / 86_400_000)}d`
}

/**
 * Scheduled automations — the Hermes equivalent of ChatGPT's "Scheduled".
 * Backed by the real `cron.manage` RPC; jobs are defined on the server, so
 * this is a read view plus pause/resume.
 */
export default function Automations() {
  const online = useStore(isConnectedAtom)
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!online) {
      setLoading(false)
      return
    }
    setError(null)
    try {
      const res = await rpc<{ jobs?: Job[]; count?: number }>('cron.manage', { action: 'list' })
      setJobs(res?.jobs ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load automations')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [online])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const toggle = async (j: Job) => {
    const action = j.enabled === false ? 'resume' : 'pause'
    try {
      await rpc('cron.manage', { action, name: j.name ?? j.job_id })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title="Automations" showBrand>
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.textDim} onRefresh={async () => { setRefreshing(true); await load() }} />}
        >
          <Text style={s.intro}>Scheduled jobs run on your gateway, so they work even when this app is closed.</Text>

          {error ? (
            <Pressable onPress={() => { setLoading(true); void load() }}>
              <Text style={s.error}>{error} — tap to retry</Text>
            </Pressable>
          ) : null}

          {loading ? <ActivityIndicator color={C.textDim} style={{ marginTop: 24 }} /> : null}

          {!loading && jobs.length === 0 && !error ? (
            <View style={s.empty}>
              <Ionicons name="timer-outline" size={28} color={C.textFaint} />
              <Text style={s.emptyTitle}>No automations yet</Text>
              <Text style={s.emptyBody}>
                Create one from the chat with{'\n'}/cron add — e.g. /cron add "daily standup" every morning
              </Text>
            </View>
          ) : null}

          {jobs.map((j) => {
            const paused = j.enabled === false || j.state === 'paused'
            return (
              <View key={j.job_id} style={s.card}>
                <View style={s.cardHead}>
                  <Ionicons name={paused ? 'pause-circle-outline' : 'timer-outline'} size={17} color={paused ? C.textFaint : C.accent} />
                  <Text style={[s.name, paused && { color: C.textDim }]} numberOfLines={1}>
                    {j.name ?? j.job_id}
                  </Text>
                  <Pressable onPress={() => { void toggle(j) }} hitSlop={10} accessibilityLabel={paused ? 'Resume' : 'Pause'}>
                    <Ionicons name={paused ? 'play-circle-outline' : 'pause-circle-outline'} size={20} color={C.textDim} />
                  </Pressable>
                </View>
                {j.prompt_preview ? <Text style={s.prompt} numberOfLines={2}>{j.prompt_preview}</Text> : null}
                <View style={s.metaRow}>
                  {j.schedule ? <Text style={s.meta}>{j.schedule}</Text> : null}
                  {j.next_run_at ? <Text style={[s.meta, { color: paused ? C.textFaint : C.accent }]}>{when(j.next_run_at)}</Text> : null}
                  {j.last_status ? <Text style={s.meta}>last: {j.last_status}</Text> : null}
                </View>
              </View>
            )
          })}
        </ScrollView>
      </ScreenShell>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  intro: { color: C.textDim, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  error: { color: C.red, fontSize: 13, paddingVertical: 8 },
  empty: { alignItems: 'center', marginTop: 48, gap: 8 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  emptyBody: { color: C.textFaint, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  card: { backgroundColor: C.bgCard, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.borderSoft },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, color: C.text, fontSize: 15, fontWeight: '600' },
  prompt: { color: C.textDim, fontSize: 13, lineHeight: 18, marginTop: 6 },
  metaRow: { flexDirection: 'row', gap: 12, marginTop: 8, flexWrap: 'wrap' },
  meta: { color: C.textFaint, fontSize: 11.5 },
})
