import React from 'react'
import { Tabs } from 'expo-router'
import { C } from '../../src/lib/theme'

/**
 * The tab bar is hidden: navigation moved into the ChatGPT-style drawer, so
 * the conversation gets the full height of the screen. The tab navigator is
 * kept because the drawer routes to these screens.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: C.bg },
        tabBarStyle: { display: 'none' },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen name="chat" />
      <Tabs.Screen name="sessions" />
      <Tabs.Screen name="agent" />
      <Tabs.Screen name="automations" />
      <Tabs.Screen name="skills" />
      <Tabs.Screen name="settings" />
    </Tabs>
  )
}
