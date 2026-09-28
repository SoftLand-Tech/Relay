/**
 * Animated cold-start brand splash.
 *
 * The native splash (config plugin) shows the logo statically on #0E181B;
 * this overlay takes over at mount with the same background and the same
 * logo width, so the handoff is invisible — then the logo settles into
 * place over two expanding cyan ripples, and the whole overlay fades out
 * over the app. Runs once per cold start (mounted from the root layout).
 * Reduced-motion users skip straight through.
 */
import React, { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet } from 'react-native'
import { C } from '../lib/theme'

/** Same width as the native splash `imageWidth`, so frame one matches it. */
const LOGO_W = 200
const LOGO_H = Math.round((LOGO_W * 608) / 800) // logo.png is 800×608

export function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const [reduced, setReduced] = useState(false)
  // Overlay starts as a pixel-for-pixel match of the native splash.
  const settle = useRef(new Animated.Value(1.045)).current
  const fade = useRef(new Animated.Value(1)).current
  const exitScale = useRef(new Animated.Value(1)).current
  const ripple1 = useRef(new Animated.Value(0)).current
  const ripple2 = useRef(new Animated.Value(0)).current

  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => { if (live) setReduced(r) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (reduced) { onDone(); return }
    const anim = Animated.sequence([
      Animated.parallel([
        // settle: the logo eases from the static splash pose into place
        Animated.timing(settle, { toValue: 1, duration: 550, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(ripple1, { toValue: 1, duration: 950, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.sequence([Animated.delay(220), Animated.timing(ripple2, { toValue: 1, duration: 950, easing: Easing.out(Easing.cubic), useNativeDriver: true })]),
      ]),
      Animated.delay(120),
      // exit: the brand moment passes through into the app
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: 400, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(exitScale, { toValue: 1.06, duration: 400, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    ])
    anim.start(({ finished }) => { if (finished) onDone() })
    return () => anim.stop()
    // onDone is a setState wrapper from the root layout — stable in practice.
  }, [reduced])

  const rippleStyle = (v: Animated.Value) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.0] }) }],
  })
  const logoStyle = {
    transform: [
      { scale: Animated.multiply(settle, exitScale) },
    ],
  }

  return (
    <Animated.View style={[s.overlay, { opacity: fade }]} accessibilityLabel="Loading Relay">
      <Animated.View style={[s.ripple, rippleStyle(ripple1)]} />
      <Animated.View style={[s.ripple, rippleStyle(ripple2)]} />
      <Animated.Image
        source={require('../../assets/logo.png')}
        style={[s.logo, logoStyle]}
        resizeMode="contain"
      />
    </Animated.View>
  )
}

const s = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0E181B', // same as the native splash backgroundColor
    alignItems: 'center',
    justifyContent: 'center',
  },
  ripple: {
    position: 'absolute',
    width: LOGO_W,
    height: LOGO_W,
    borderRadius: LOGO_W / 2,
    borderWidth: 2,
    borderColor: C.accent,
  },
  logo: {
    width: LOGO_W,
    height: LOGO_H,
  },
})
