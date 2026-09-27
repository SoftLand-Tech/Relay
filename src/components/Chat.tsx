import React, { useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
// The maintained fork. The original `react-native-markdown-display` pins
// markdown-it 10, which does `require('punycode')` — a Node builtin that
// Metro's Hermes runtime does not provide, so it breaks the Android bundle.
// This fork resolves markdown-it 14, which imports the userland `punycode.js`
// package instead. Same `<Markdown style={...}>` API.
import Markdown from '@ronradtke/react-native-markdown-display'
import * as Clipboard from 'expo-clipboard'
import * as Speech from 'expo-speech'
import { Ionicons } from '@expo/vector-icons'
import { speakText, stopTts } from '../lib/voice'
import { C } from '../lib/theme'
import type { ChatMessage, ToolItem } from '../lib/chat'

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const mdStyles = {
  body: { color: C.text, fontSize: 16, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 12 },
  code_inline: { color: C.accent, backgroundColor: 'rgba(47,140,255,0.12)', borderRadius: 4, paddingHorizontal: 5, fontSize: 14.5 },
  fence: { color: C.text, backgroundColor: '#0D0D0D', borderRadius: 10, padding: 12, fontSize: 13, fontFamily: 'monospace' },
  code_block: { color: C.text, backgroundColor: '#0D0D0D', borderRadius: 10, padding: 12, fontSize: 13, fontFamily: 'monospace' },
  blockquote: { backgroundColor: 'transparent', borderLeftColor: C.border, marginLeft: 0, paddingLeft: 12 },
  link: { color: C.accent },
  bullet_list: { color: C.text },
  ordered_list: { color: C.text },
  heading1: { color: C.text, fontSize: 21, fontWeight: '700' },
  heading2: { color: C.text, fontSize: 18, fontWeight: '700' },
  heading3: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  hr: { backgroundColor: C.border, height: 1 },
  table: { borderColor: C.border },
  th: { color: C.text, borderColor: C.border },
  td: { color: C.textDim, borderColor: C.border },
} as never

export function MessageBubble({ m, onRetry }: { m: ChatMessage; onRetry?: (id: string) => void }) {
  const isUser = m.role === 'user'
  const [copied, setCopied] = useState(false)
  const [speakState, setSpeakState] = useState<'idle' | 'loading' | 'playing'>('idle')

  const copy = async () => {
    await Clipboard.setStringAsync(m.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const toggleSpeak = async () => {
    if (speakState !== 'idle') {
      stopTts()
      try {
        Speech.stop()
      } catch {}
      setSpeakState('idle')
      return
    }
    setSpeakState('loading')
    try {
      // Gateway voice (Deepgram/Edge/… — whatever the server runs)
      await speakText(m.text.slice(0, 3000))
      setSpeakState('playing')
    } catch {
      // Fallback: on-device TTS so Listen always does something
      try {
        Speech.speak(m.text.slice(0, 2000), {
          onDone: () => setSpeakState('idle'),
          onStopped: () => setSpeakState('idle'),
          onError: () => setSpeakState('idle'),
        })
        setSpeakState('playing')
      } catch {
        setSpeakState('idle')
      }
    }
  }

  // ChatGPT renders the assistant unboxed and full width; only the user gets a bubble.
  if (!isUser) {
    return (
      <View style={s.botWrap}>
        <Markdown style={mdStyles}>{m.text || (m.streaming ? '' : '')}</Markdown>
        {m.streaming ? <Text style={s.cursor}>▍</Text> : null}
        {m.status === 'failed' ? (
          <View style={s.failedRow}>
            <Ionicons name="alert-circle" size={15} color={C.red} />
            <Text style={s.failedText}>{m.error ?? 'Something went wrong'}</Text>
          </View>
        ) : null}
        {m.text && !m.streaming ? (
          <View style={s.botActions}>
            <Text style={s.time}>{fmtTime(m.ts)}</Text>
            <Pressable onPress={copy} hitSlop={10} style={s.iconBtn} accessibilityLabel="Copy message">
              <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={15} color={copied ? C.greenSoft : C.textFaint} />
            </Pressable>
            <Pressable onPress={() => { void toggleSpeak() }} hitSlop={10} style={s.iconBtn} accessibilityLabel={speakState === 'playing' ? 'Stop playback' : 'Listen'}>
              {speakState === 'loading' ? (
                <ActivityIndicator color={C.textFaint} size="small" />
              ) : (
                <Ionicons name={speakState === 'playing' ? 'stop' : 'volume-medium-outline'} size={16} color={speakState === 'playing' ? C.text : C.textFaint} />
              )}
            </Pressable>
          </View>
        ) : null}
      </View>
    )
  }

  return (
    <View style={s.userWrap}>
      <View style={s.userBubble}>
        <Text style={s.userText} selectable>
          {m.text}
        </Text>
      </View>
      {m.status === 'failed' ? (
        <View style={s.failedRow}>
          <Ionicons name="alert-circle" size={15} color={C.red} />
          <Text style={s.failedText}>{m.error ?? 'Not sent'}</Text>
          {onRetry ? (
            <Pressable onPress={() => onRetry(m.id)} style={s.retryBtn} accessibilityLabel="Retry send">
              <Ionicons name="refresh" size={13} color={C.text} />
              <Text style={s.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

export function ThinkingPanel({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  const short = open ? text.slice(-4000) : text.length > 400 ? text.slice(-400) : text
  return (
    <Pressable onPress={() => setOpen(!open)} accessibilityLabel={open ? 'Collapse thinking' : 'Expand thinking'}>
      <View style={s.think}>
        <View style={s.thinkHead}>
          <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={12} color={C.textFaint} />
          <Text style={s.thinkLabel}>Thought for a moment</Text>
        </View>
        <Text style={s.thinkText} numberOfLines={open ? undefined : 4}>
          {short}
        </Text>
      </View>
    </Pressable>
  )
}

export function ToolRow({ t }: { t: ToolItem }) {
  const color = t.status === 'running' ? C.accent : t.status === 'failed' ? C.red : C.greenSoft
  return (
    <View style={s.toolRow} accessibilityLabel={`${t.name} ${t.status}`}>
      {t.status === 'running' ? (
        <ActivityIndicator size="small" color={color} style={{ width: 14 }} />
      ) : (
        <Ionicons name={t.status === 'failed' ? 'close' : 'checkmark'} size={13} color={color} />
      )}
      <Text style={s.toolName}>{t.name}</Text>
      {t.preview ? (
        <Text style={s.toolPreview} numberOfLines={1}>
          {t.preview}
        </Text>
      ) : null}
      {t.durationS != null ? <Text style={s.toolDur}>{(t.durationS).toFixed(1)}s</Text> : null}
    </View>
  )
}

const s = StyleSheet.create({
  botWrap: { paddingHorizontal: 16, paddingVertical: 10 },
  userWrap: { paddingHorizontal: 16, paddingVertical: 6, alignItems: 'flex-end' },
  userBubble: { backgroundColor: C.userBubble, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '88%' },
  userText: { color: C.text, fontSize: 16, lineHeight: 23 },
  cursor: { color: C.textDim, fontSize: 15, marginTop: 2 },
  botActions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, marginLeft: -6 },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 15 },
  time: { color: C.textFaint, fontSize: 11, marginRight: 6 },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  failedText: { color: C.red, fontSize: 12.5, flexShrink: 1 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgCard, borderRadius: 14, paddingHorizontal: 10, height: 30 },
  retryText: { color: C.text, fontSize: 12, fontWeight: '700' },
  think: { marginHorizontal: 16, marginVertical: 4, backgroundColor: C.bgCard, borderRadius: 12, padding: 10 },
  thinkHead: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  thinkLabel: { color: C.textFaint, fontSize: 11.5, fontWeight: '600' },
  thinkText: { color: C.textDim, fontSize: 12.5, lineHeight: 18 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 4 },
  toolName: { color: C.textDim, fontSize: 12.5, fontWeight: '600' },
  toolPreview: { color: C.textFaint, fontSize: 12, flexShrink: 1 },
  toolDur: { color: C.textFaint, fontSize: 11 },
})
