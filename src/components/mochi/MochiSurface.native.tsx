/**
 * Native mascot surface: one WebView holding ALL 32 pre-mounted, paused state
 * chunks in a single document. State switches are one class toggle in that
 * document (`window.__mochSet`) — never a re-mount, never a re-source, never
 * a fetch. Transparent, non-interactive, fades in 150ms on first load.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { mochiDocument, type MochiStateName } from './mochiStates.gen'
import type { MochiSurfaceHandle, MochiSurfaceProps } from './MochiSurfaceCommon'

export const MochiSurface = forwardRef<MochiSurfaceHandle, MochiSurfaceProps>(
  function MochiSurface({ state }, ref) {
    const webRef = useRef<WebView>(null)
    // Android injection timing: anything desired before the document finishes
    // loading is buffered here and applied on onLoadEnd — no idle-flash.
    const loadedRef = useRef(false)
    const pendingRef = useRef<MochiStateName | null>(null)
    const lastInjectedRef = useRef<MochiStateName | null>(null)
    const fade = useRef(new Animated.Value(0)).current
    // Memoized once — the document is static for the surface's lifetime.
    const html = useMemo(() => mochiDocument(__DEV__), [])

    const inject = (name: MochiStateName) => {
      lastInjectedRef.current = name
      // __mochForce exists only when the dev flag is baked into the document;
      // fall back to __mochSet so a stale dev ref can't no-op in release.
      const fn = __DEV__ ? 'window.__mochForce' : 'window.__mochSet'
      webRef.current?.injectJavaScript(`${fn}('${name}');true;`)
    }

    useImperativeHandle(
      ref,
      () => ({
        force: (name: MochiStateName) => {
          if (!loadedRef.current) {
            pendingRef.current = name
            return
          }
          inject(name)
        },
      }),
      [],
    )

    useEffect(() => {
      if (!loadedRef.current) {
        pendingRef.current = state
        return
      }
      // Guard: fire only when the desired state differs from the last-injected
      // one — per-flush re-evaluations recompute equal states.
      if (state !== lastInjectedRef.current) inject(state)
    }, [state])

    const applyPending = () => {
      loadedRef.current = true
      const wanted = pendingRef.current
      pendingRef.current = null
      if (wanted && wanted !== lastInjectedRef.current) inject(wanted)
      // 150ms first-load fade-in; reduced-motion users get a hard cut.
      const start = () => Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start()
      AccessibilityInfo.isReduceMotionEnabled?.()
        .then((rm) => (rm ? fade.setValue(1) : start()))
        .catch(start)
    }

    return (
      <Animated.View style={[s.fill, { opacity: fade }]} pointerEvents="none">
        <View style={s.fill} pointerEvents="none" aria-hidden={true}>
          <WebView
            ref={webRef}
            source={{ html }}
            onLoadEnd={applyPending}
            style={s.fill}
            containerStyle={s.fill}
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
            originWhitelist={['*']}
          />
        </View>
      </Animated.View>
    )
  },
)

const s = StyleSheet.create({
  fill: { width: '100%', height: '100%', backgroundColor: 'transparent' },
})
