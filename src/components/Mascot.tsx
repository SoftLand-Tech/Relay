import React, { useEffect, useRef, useState } from 'react'
import { AppState, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { useStore } from '@nanostores/react'
import { MochiSurface } from './mochi/MochiSurface'
import type { MochiSurfaceHandle } from './mochi/MochiSurfaceCommon'
import { mochiCommitted, type UseMochiState } from './mochi/useMochiState'
import { MOCHI_STATE_NAMES, type MochiStateName } from './mochi/mochiStates.gen'

const BOX = 144
/** Soft haptic pulse while the head-pat hold continues. */
const PAT_PULSE_MS = 900

/**
 * The chat mascot: press-and-hold to pat (T0), tap for a wink, and — dev
 * builds only — long-press 800ms for the 32-state picker (KNOWN COSMETIC:
 * those 800ms play as a head-pat before the sheet opens; accepted, no
 * gesture arbitration). The wrapper is pointerEvents 'box-none' so ONLY the
 * 144px square is touchable — the composer, queue strip and list scroll are
 * never intercepted.
 *
 * This leaf owns the mascot-state subscription (`mochiCommitted`): the
 * waterfall's 400ms heartbeat re-renders at most this 144px square, never
 * the host Chat screen.
 */
export function Mascot({ mochi }: { mochi: UseMochiState }) {
  const state = useStore(mochiCommitted)
  const surfaceRef = useRef<MochiSurfaceHandle>(null)
  const pulseRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pressedRef = useRef(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const stopPulse = () => {
    if (pulseRef.current) {
      clearInterval(pulseRef.current)
      pulseRef.current = null
    }
  }
  useEffect(() => stopPulse, [])

  // App blur mid-press = touch cancel: the pat ends with the finger's life.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' && pressedRef.current) {
        pressedRef.current = false
        stopPulse()
        mochi.onPressOut()
      }
    })
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mochi])

  const haptic = () => {
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    } catch {
      /* web/desktop without vibration hardware — silent */
    }
  }

  return (
    <View style={s.wrap} pointerEvents="box-none">
      <Pressable
        style={s.box}
        accessibilityRole="button"
        accessibilityLabel="Mochi the mascot"
        onPressIn={() => {
          pressedRef.current = true
          haptic()
          pulseRef.current = setInterval(haptic, PAT_PULSE_MS)
          mochi.onPressIn()
        }}
        onPressOut={() => {
          pressedRef.current = false
          stopPulse()
          mochi.onPressOut()
        }}
        onLongPress={__DEV__ ? () => setPickerOpen(true) : undefined}
        delayLongPress={800}
      >
        <MochiSurface ref={surfaceRef} state={state} />
      </Pressable>

      {__DEV__ ? (
        <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
          <Pressable style={s.scrim} onPress={() => setPickerOpen(false)}>
            <View style={s.sheet}>
              <Text style={s.sheetTitle}>Force a Mochi state (dev)</Text>
              {MOCHI_STATE_NAMES.map((name) => (
                <Pressable
                  key={name}
                  style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                  onPress={() => {
                    setPickerOpen(false)
                    surfaceRef.current?.force(name)
                  }}
                >
                  <Text style={s.rowText}>{name}</Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  )
}

/**
 * The bare mascot for surfaces with no waterfall and no touch target (the
 * connection overlay). Mounts fresh with its surface — inside the 94%-black
 * veil the status text appears first and Mochi fades in a beat later
 * (cold WebView start ~200-500ms on low-end devices; accepted).
 */
export function MochiStage({ state, marginBottom = 12 }: { state: MochiStateName; marginBottom?: number }) {
  return (
    <View style={[s.stage, { marginBottom }]} pointerEvents="none" aria-hidden={true}>
      <MochiSurface state={state} />
    </View>
  )
}

const s = StyleSheet.create({
  // The wrapper lets touches pass everywhere except the square itself.
  // marginBottom 4 keeps the chat-screen mount geometry of the old box.
  wrap: { alignSelf: 'center', marginBottom: 4 },
  box: {
    width: BOX,
    height: BOX,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  stage: {
    width: BOX,
    height: BOX,
    alignSelf: 'center',
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 32 },
  sheet: {
    backgroundColor: '#1B1926',
    borderRadius: 16,
    padding: 16,
    maxHeight: '80%',
  },
  sheetTitle: { color: '#FAF1E7', fontSize: 14, fontWeight: '700', marginBottom: 8 },
  row: { paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8 },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
  rowText: { color: '#FAF1E7', fontSize: 13.5 },
})
