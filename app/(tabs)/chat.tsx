import React, { useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import * as Haptics from 'expo-haptics'
import { AudioModule, useAudioRecorder, RecordingPresets } from 'expo-audio'
import { transcribeRecording, voiceBusy } from '../../src/lib/voice'
import { clearBadge } from '../../src/lib/push'
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router'
import {
  messages,
  tools,
  thinking,
  agentBusy,
  pendingRequest,
  usage,
  todos,
  outbox,
  activeTitle,
  sendPrompt,
  stopRun,
  steerRun,
  respondApproval,
  respondClarify,
  respondClarifyBatch,
  respondPrivileged,
  ensureSession,
  activeSession,
  retryMessage,
  flushOutbox,
  pushLocalMessage,
  type ToolItem,
} from '../../src/lib/chat'
import { isConnected as isConnectedAtom, connectionState, gatewayError, retryNow } from '../../src/lib/gateway'
import { completeSlash, loadCatalog, runCommand, type CompletionItem, type SlashOutcome } from '../../src/lib/slash'
import { MessageBubble, ThinkingPanel, ToolRow } from '../../src/components/Chat'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C } from '../../src/lib/theme'

/** Empty-state prompts, styled as plain icon rows the way ChatGPT does. */
const STARTERS = [
  { icon: 'sparkles-outline' as const, label: 'What can you do?' },
  { icon: 'document-text-outline' as const, label: 'Summarize my day' },
  { icon: 'terminal-outline' as const, label: 'Explain this repo' },
  { icon: 'help-circle-outline' as const, label: 'Browse slash commands' },
]

const MAX_SLASH_ITEMS = 120

export default function Chat() {
  const msgs = useStore(messages)
  const tls = useStore(tools)
  const think = useStore(thinking)
  const busy = useStore(agentBusy)
  const req = useStore(pendingRequest)
  const use = useStore(usage)
  const td = useStore(todos)
  const qb = useStore(outbox)
  const title = useStore(activeTitle)
  const sid = useStore(activeSession)
  const online = useStore(isConnectedAtom)
  const conn = useStore(connectionState)
  const gerr = useStore(gatewayError)
  const [input, setInput] = useState('')
  const [steerMode, setSteerMode] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({})
  const [stick, setStick] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [slashItems, setSlashItems] = useState<CompletionItem[] | null>(null)
  const listRef = useRef<FlatList>(null)
  const insets = useSafeAreaInsets()
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const voiceState = useStore(voiceBusy)
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const slashSeq = useRef(0)

  useFocusEffect(() => {
    void clearBadge()
  })

  // The Skills screen hands over a command to pre-fill (`/model ` etc).
  const { draft } = useLocalSearchParams<{ draft?: string }>()
  const lastDraft = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!draft || draft === lastDraft.current) return
    lastDraft.current = draft
    setInput(draft)
  }, [draft])

  useEffect(() => {
    if (!online) return
    void (async () => {
      try {
        await ensureSession()
        await loadCatalog()
        await flushOutbox().catch(() => {})
      } catch {
        /* the offline banner already explains it */
      }
    })()
  }, [online])

  useEffect(() => {
    if (!stick) return
    const t = setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 80)
    return () => clearTimeout(t)
  }, [msgs.length, msgs[msgs.length - 1]?.text, tls.length, think.length, stick])

  // ── Slash palette ──────────────────────────────────────────────────────
  const slashQuery = input.startsWith('/') ? input.split('\n')[0] : null

  useEffect(() => {
    if (slashQuery === null) {
      setSlashItems(null)
      return
    }
    const seq = ++slashSeq.current
    const t = setTimeout(async () => {
      try {
        const items = await completeSlash(slashQuery, sid ?? undefined)
        if (seq === slashSeq.current) setSlashItems(items.slice(0, MAX_SLASH_ITEMS))
      } catch {
        if (seq === slashSeq.current) setSlashItems(null)
      }
    }, 120)
    return () => clearTimeout(t)
  }, [slashQuery, sid])

  const runSlash = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return
    try {
      const s = sid ?? (await ensureSession())
      const out: SlashOutcome = await runCommand(trimmed, s)

      if (out.action === 'send' && out.text) {
        // The gateway asked for this text to go through as a real turn.
        setInput('')
        setSlashItems(null)
        await sendPrompt(out.text)
        return
      }
      if (out.action === 'prefill' && out.text) {
        // Review-then-send: drop it in the composer, don't send.
        setInput(out.text)
        setSlashItems(null)
        return
      }
      if (out.action === 'show' && out.text) {
        pushLocalMessage(out.text)
      }
      setInput('')
      setSlashItems(null)
    } catch (e) {
      Alert.alert('Command failed', e instanceof Error ? e.message : String(e))
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text) return
    if (text.startsWith('/')) {
      setInput('')
      await runSlash(text)
      return
    }
    if (busy && !steerMode) return
    try {
      if (steerMode && busy) {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        setInput('')
        setSteerMode(false)
        await steerRun(text)
      } else if (busy) {
        return
      } else {
        setInput('')
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        await sendPrompt(text)
      }
    } catch (e) {
      setInput(text)
      Alert.alert('Send failed', e instanceof Error ? e.message : 'unknown')
    }
  }

  // ── Voice ──────────────────────────────────────────────────────────────
  const stopRecTimer = () => {
    if (recTimer.current) {
      clearInterval(recTimer.current)
      recTimer.current = null
    }
  }

  const finishRecording = async () => {
    stopRecTimer()
    setRecording(false)
    let uri: string | null = null
    try {
      await recorder.stop()
      uri = recorder.uri ?? null
    } catch (e) {
      Alert.alert('Recording failed', e instanceof Error ? e.message : 'unknown')
      return
    }
    if (!uri) {
      Alert.alert('Recording failed', 'No audio captured.')
      return
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      const { transcript, provider } = await transcribeRecording(uri)
      setInput(transcript)
      if (provider) Alert.alert(`Transcribed (${provider})`, 'Review and send.')
    } catch (e) {
      Alert.alert('Transcription failed', e instanceof Error ? e.message : 'unknown')
    }
  }

  const toggleRecord = async () => {
    if (voiceState) return
    try {
      if (recording) {
        await finishRecording()
        return
      }
      const st = await AudioModule.requestRecordingPermissionsAsync()
      if (!st.granted) {
        Alert.alert('Mic denied', 'Allow microphone access to record voice.')
        return
      }
      await recorder.prepareToRecordAsync()
      recorder.record()
      setRecording(true)
      setRecSecs(0)
      recTimer.current = setInterval(() => {
        setRecSecs((n) => {
          if (n + 1 >= 120) void finishRecording()
          return n + 1
        })
      }, 1000)
    } catch (e) {
      stopRecTimer()
      setRecording(false)
      Alert.alert('Recording failed', e instanceof Error ? e.message : 'unknown')
    }
  }

  useEffect(() => stopRecTimer, [])
  useEffect(() => {
    setAnswerText('')
    setSecretValue('')
    setBatchAnswers({})
  }, [req?.id])

  const isBatchClarify = req?.method === 'clarify' && !!req.questions?.length
  const approvalChoices = (() => {
    if (req?.method !== 'approval') return []
    const offered = req.choices?.length ? req.choices : ['once', 'session', 'always', 'deny']
    return offered.filter((c) => {
      if (c === 'always' && req.allowPermanent === false) return false
      if (c === 'session' && req.allowSession === false) return false
      return true
    })
  })()

  const canSend = !!input.trim() && (!busy || steerMode)
  const isSlashMode = slashQuery !== null
  const cmdCount = slashItems?.filter((i) => i.kind !== 'skill').length ?? 0
  const skillCount = slashItems?.filter((i) => i.kind === 'skill').length ?? 0

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title={title || 'Hermes'} onSearch={() => router.push('/(tabs)/sessions')}>
        <KeyboardAvoidingView
          style={s.root}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          {!online ? (
            <Pressable style={s.banner} onPress={() => { void retryNow().catch(() => {}) }} accessibilityLabel="Reconnect">
              <Text style={s.bannerText}>
                {conn === 'connecting' ? 'Connecting…' : `Offline${gerr ? ' — tap to retry' : ''}`}
                {qb.length ? ` · ${qb.length} queued` : ''}
              </Text>
            </Pressable>
          ) : null}

          <FlatList
            ref={listRef}
            data={msgs}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <MessageBubble m={item} onRetry={(id) => { void retryMessage(id).catch(() => {}) }} />
            )}
            contentContainerStyle={{ paddingBottom: 16, flexGrow: msgs.length ? 0 : 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onScroll={(e) => {
              const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
              const nearBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y) < 120
              setStick(nearBottom)
              setShowScrollBtn(!nearBottom && msgs.length > 5)
            }}
            scrollEventThrottle={200}
            ListEmptyComponent={
              <View style={s.empty}>
                {STARTERS.map((st) => (
                  <Pressable
                    key={st.label}
                    style={({ pressed }) => [s.starter, pressed && s.starterPressed]}
                    onPress={() => {
                      if (st.label === 'Browse slash commands') setInput('/')
                      else setInput(st.label)
                    }}
                    accessibilityLabel={st.label}
                  >
                    <Ionicons name={st.icon} size={19} color={C.textDim} />
                    <Text style={s.starterText}>{st.label}</Text>
                  </Pressable>
                ))}
              </View>
            }
          />

          {/* Run status — quiet, above the composer. */}
          {(tls.length > 0 || (think.length > 0 && busy) || td.length > 0) ? (
            <View style={s.runFooter}>
              {tls.slice(-3).map((t: ToolItem) => <ToolRow key={t.id} t={t} />)}
              {tls.length > 3 ? <Text style={s.moreTools}>+{tls.length - 3} more</Text> : null}
              {think.length > 0 && busy ? <ThinkingPanel text={think} /> : null}
              {td.length > 0 ? (
                <View style={s.todos}>
                  {td.slice(0, 4).map((t, i) => (
                    <Text key={i} style={s.todo}>
                      {t.done ? '✓' : '○'} {t.text}
                    </Text>
                  ))}
                </View>
              ) : null}
              {use ? <Text style={s.usage}>{use}</Text> : null}
            </View>
          ) : null}

          {showScrollBtn ? (
            <Pressable style={s.fab} onPress={() => { setStick(true); listRef.current?.scrollToEnd?.({ animated: true }) }} accessibilityLabel="Jump to latest">
              <Ionicons name="arrow-down" size={19} color={C.text} />
            </Pressable>
          ) : null}

          {/* Slash palette */}
          {slashItems && slashItems.length > 0 ? (
            <View style={s.slashPanel}>
              <View style={s.slashHead}>
                <Ionicons name="terminal-outline" size={13} color={C.accent} />
                <Text style={s.slashHeadText}>
                  {cmdCount} command{cmdCount === 1 ? '' : 's'} · {skillCount} skill{skillCount === 1 ? '' : 's'}
                </Text>
                <Text style={s.slashHint}>tap to fill</Text>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 320 }}>
                {slashItems.map((it, i) => {
                  // complete.slash returns `text` without the leading slash
                  // and `display` with it, for both commands and skills.
                  const isSkill = it.kind === 'skill'
                  const label = it.display ?? (it.text.startsWith('/') ? it.text : `/${it.text}`)
                  const insertable = it.text.startsWith('/') ? it.text : `/${it.text}`
                  return (
                    <Pressable
                      key={`${it.kind ?? 'c'}-${insertable}-${i}`}
                      style={({ pressed }) => [s.slashRow, pressed && s.slashRowPressed]}
                      onPress={() => {
                        setInput(insertable)
                        setSlashItems(null)
                      }}
                      accessibilityLabel={`${label}, ${isSkill ? 'skill' : 'command'}`}
                    >
                      <Ionicons
                        name={isSkill ? 'sparkles-outline' : 'terminal-outline'}
                        size={14}
                        color={isSkill ? C.accent : C.textFaint}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={s.slashName}>{label}</Text>
                        {it.meta ? (
                          <Text style={s.slashMeta} numberOfLines={2}>
                            {it.meta}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={s.slashKind}>{isSkill ? 'skill' : 'cmd'}</Text>
                    </Pressable>
                  )
                })}
              </ScrollView>
            </View>
          ) : null}

          {/* Question cards */}
          {req?.method === 'approval' ? (
            <View style={s.sheet}>
              <View style={s.sheetHead}>
                <Ionicons name="shield-checkmark-outline" size={15} color={C.amber} />
                <Text style={s.sheetTitle}>
                  Approval needed{req.replayed ? ' (restored)' : ''}
                </Text>
              </View>
              {req.toolName ? <Text style={s.sheetKicker}>{req.toolName}</Text> : null}
              <Text style={s.sheetBody} selectable>
                {req.command ?? req.description ?? 'The agent wants to run a command.'}
              </Text>
              {req.description && req.description !== req.command ? (
                <Text style={s.sheetDesc}>{req.description}</Text>
              ) : null}
              <View style={s.sheetRow}>
                {approvalChoices.map((c) => {
                  const deny = c === 'deny'
                  return (
                    <Pressable
                      key={c}
                      style={[s.sheetBtn, deny ? s.denyBtn : { backgroundColor: c === 'always' ? C.accentDark : C.accent }]}
                      onPress={() => {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
                        void respondApproval(c as 'once' | 'session' | 'always' | 'deny')
                      }}
                      accessibilityLabel={c}
                    >
                      <Text style={s.sheetBtnText}>
                        {c === 'once' ? 'Allow' : c === 'session' ? 'Always this chat' : c === 'always' ? 'Always' : 'Deny'}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          ) : null}

          {req?.method === 'clarify' ? (
            <View style={s.sheet}>
              <View style={s.sheetHead}>
                <Ionicons name="help-circle-outline" size={15} color={C.accent} />
                <Text style={s.sheetTitle}>Hermes needs you</Text>
              </View>
              {isBatchClarify ? (
                <>
                  {req.questions!.map((q) => (
                    <View key={q.qid} style={{ marginBottom: 10 }}>
                      <Text style={s.qText}>{q.question ?? q.qid}</Text>
                      {q.choices?.map((o) => (
                        <Pressable
                          key={o}
                          style={[s.clarifyBtn, batchAnswers[q.qid] === o && s.clarifyOn]}
                          onPress={() => setBatchAnswers((a) => ({ ...a, [q.qid]: o }))}
                        >
                          <Text style={s.clarifyText}>{o}</Text>
                        </Pressable>
                      ))}
                      {!q.choices?.length ? (
                        <TextInput
                          style={s.qInput}
                          value={batchAnswers[q.qid] ?? ''}
                          onChangeText={(t) => setBatchAnswers((a) => ({ ...a, [q.qid]: t }))}
                          placeholder="Your answer…"
                          placeholderTextColor={C.textFaint}
                          accessibilityLabel={`Answer ${q.qid}`}
                        />
                      ) : null}
                    </View>
                  ))}
                  <Pressable style={[s.sheetBtn, { backgroundColor: C.accent }]} onPress={() => { void respondClarifyBatch(batchAnswers) }}>
                    <Text style={s.sheetBtnText}>Send</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={s.sheetBody}>{req.question ?? 'Clarification needed'}</Text>
                  {req.options?.map((o) => (
                    <Pressable key={o} style={s.clarifyBtn} onPress={() => { void respondClarify(o) }}>
                      <Text style={s.clarifyText}>{o}</Text>
                    </Pressable>
                  ))}
                  <View style={s.clarifyRow}>
                    <TextInput
                      style={[s.qInput, { flex: 1 }]}
                      value={answerText}
                      onChangeText={setAnswerText}
                      placeholder="Or type your answer…"
                      placeholderTextColor={C.textFaint}
                      accessibilityLabel="Clarification answer"
                    />
                    <Pressable
                      style={s.miniSend}
                      onPress={() => { const t = answerText; setAnswerText(''); void respondClarify(t) }}
                      accessibilityLabel="Send clarification"
                    >
                      <Ionicons name="arrow-up" size={17} color="#FFFFFF" />
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          ) : null}

          {(req?.method === 'sudo' || req?.method === 'secret') ? (
            <View style={s.sheet}>
              <View style={s.sheetHead}>
                <Ionicons name="lock-closed-outline" size={15} color={C.red} />
                <Text style={[s.sheetTitle, { color: C.red }]}>
                  {req.method === 'sudo' ? 'Sudo requested' : 'Secret requested'}
                </Text>
              </View>
              <Text style={s.sheetBody} selectable>
                {req.prompt}
              </Text>
              <TextInput
                style={s.qInput}
                value={secretValue}
                onChangeText={setSecretValue}
                placeholder={req.method === 'sudo' ? 'sudo password…' : `Value for ${req.envVar ?? 'secret'}…`}
                placeholderTextColor={C.textFaint}
                secureTextEntry
                accessibilityLabel="Secret value"
              />
              <View style={[s.sheetRow, { marginTop: 10 }]}>
                <Pressable style={[s.sheetBtn, { backgroundColor: C.accent }]} onPress={() => { const v = secretValue; setSecretValue(''); void respondPrivileged(true, v || undefined) }}>
                  <Text style={s.sheetBtnText}>Send</Text>
                </Pressable>
                <Pressable style={[s.sheetBtn, s.denyBtn]} onPress={() => { setSecretValue(''); void respondPrivileged(false) }}>
                  <Text style={[s.sheetBtnText, { color: C.red }]}>Deny</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* ── Composer: rounded pill, like ChatGPT ── */}
          <View style={[s.composerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <View style={s.composer}>
              <Pressable
                style={s.attach}
                onPress={() => Alert.alert('Attachments', 'Send an image or file and Hermes will pick it up.')}
                hitSlop={8}
                accessibilityLabel="Add attachment"
              >
                <Ionicons name="add" size={22} color={C.textDim} />
              </Pressable>

              <TextInput
                style={s.input}
                value={input}
                onChangeText={setInput}
                placeholder={
                  isSlashMode ? 'Filter commands…' : steerMode && busy ? 'Steer the running task…' : busy ? 'Working…' : 'Ask Hermes'
                }
                placeholderTextColor={C.textFaint}
                multiline={Platform.OS !== 'web'}
                returnKeyType="send"
                onSubmitEditing={() => { if (Platform.OS === 'web') void send() }}
                accessibilityLabel="Message input"
                editable={busy ? steerMode : true}
              />

              {busy ? (
                <Pressable
                  style={s.sendBtn}
                  onPress={() => { void stopRun() }}
                  hitSlop={8}
                  accessibilityLabel="Stop"
                >
                  <Ionicons name="stop" size={17} color="#FFFFFF" />
                </Pressable>
              ) : (
                <Pressable
                  style={[s.iconCircle, recording && s.recOn]}
                  onPress={toggleRecord}
                  disabled={!!voiceState}
                  hitSlop={8}
                  accessibilityLabel={recording ? `Stop recording (${recSecs}s)` : 'Record voice'}
                >
                  {voiceState === 'transcribing' ? (
                    <ActivityIndicator color={C.textDim} size="small" />
                  ) : (
                    <Ionicons name={recording ? 'square' : 'mic-outline'} size={19} color={recording ? '#fff' : C.textDim} />
                  )}
                </Pressable>
              )}

              <Pressable
                style={[s.sendBtn, !canSend && s.sendOff]}
                onPress={() => { void send() }}
                disabled={!canSend}
                hitSlop={8}
                accessibilityLabel={steerMode && busy ? 'Send steer' : 'Send message'}
              >
                <Ionicons
                  name={isSlashMode ? 'return-down-back' : steerMode && busy ? 'bulb' : 'arrow-up'}
                  size={18}
                  color={canSend ? '#FFFFFF' : C.textFaint}
                />
              </Pressable>
            </View>

            {busy ? (
              <Pressable
                style={s.steerChip}
                onPress={() => setSteerMode(!steerMode)}
                accessibilityRole="button"
                accessibilityLabel={steerMode ? 'Steer mode on' : 'Steer mode'}
              >
                <Ionicons name="git-branch-outline" size={12} color={steerMode ? '#0B0B0B' : C.textDim} />
                <Text style={[s.steerText, steerMode && { color: '#0B0B0B' }]}>Steer</Text>
              </Pressable>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </ScreenShell>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  banner: { backgroundColor: '#241A08', paddingVertical: 9, paddingHorizontal: 14 },
  bannerText: { color: C.amber, fontSize: 12.5, fontWeight: '600', textAlign: 'center' },
  empty: { paddingHorizontal: 16, paddingTop: 24, gap: 2 },
  starter: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 44, justifyContent: 'flex-start' },
  starterPressed: { opacity: 0.6 },
  starterText: { color: C.textDim, fontSize: 15.5, fontWeight: '500' },
  runFooter: { borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.bg, paddingVertical: 4, maxHeight: 190 },
  moreTools: { color: C.textFaint, fontSize: 11.5, paddingHorizontal: 16, marginTop: 2 },
  todos: { paddingHorizontal: 16, paddingVertical: 2 },
  todo: { color: C.textDim, fontSize: 12.5, lineHeight: 18 },
  usage: { color: C.textFaint, fontSize: 11, paddingHorizontal: 16, paddingBottom: 2 },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 96,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  slashPanel: { borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.bgElev },
  slashHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  slashHeadText: { color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, flex: 1 },
  slashHint: { color: C.textFaint, fontSize: 10.5 },
  slashRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, minHeight: 44 },
  slashRowPressed: { backgroundColor: C.bgHover },
  slashName: { color: C.text, fontSize: 14, fontWeight: '600' },
  slashMeta: { color: C.textFaint, fontSize: 11.5, marginTop: 1, lineHeight: 15 },
  slashKind: { color: C.textFaint, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  sheet: { marginHorizontal: 12, marginBottom: 8, backgroundColor: C.bgElev, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.border },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  sheetTitle: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  sheetKicker: { color: C.textFaint, fontSize: 11.5, marginBottom: 4 },
  sheetBody: { color: C.text, fontSize: 14.5, lineHeight: 21, marginBottom: 12 },
  sheetDesc: { color: C.textDim, fontSize: 12.5, marginBottom: 10, lineHeight: 18 },
  sheetRow: { flexDirection: 'row', gap: 8 },
  sheetBtn: { flex: 1, borderRadius: 22, paddingVertical: 11, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  denyBtn: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.red },
  sheetBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  qText: { color: C.text, fontSize: 14.5, marginBottom: 6, lineHeight: 20 },
  qInput: { backgroundColor: C.bgCard, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 11, color: C.text, fontSize: 15, marginTop: 8, minHeight: 44 },
  clarifyBtn: { backgroundColor: C.bgCard, borderRadius: 20, paddingVertical: 11, alignItems: 'center', marginTop: 6, minHeight: 44, justifyContent: 'center' },
  clarifyOn: { backgroundColor: C.accent },
  clarifyText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  clarifyRow: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' },
  miniSend: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  composerWrap: { paddingHorizontal: 12, paddingTop: 6, backgroundColor: C.bg },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: C.bgElev,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  attach: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, color: C.text, fontSize: 16, maxHeight: 110, minHeight: 34, paddingTop: 7, paddingBottom: 7, paddingHorizontal: 4 },
  iconCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  recOn: { backgroundColor: C.red },
  sendBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendOff: { backgroundColor: C.bgCard },
  steerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 10,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.bgCard,
  },
  steerText: { color: C.textDim, fontSize: 11.5, fontWeight: '700' },
})
