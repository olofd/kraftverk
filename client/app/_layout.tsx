import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider, Theme } from 'tamagui';

import config, { BACKGROUNDS } from '../tamagui.config';
import { DevicesProvider } from '../src/state/DevicesProvider';
import { DirectLinkProvider } from '../src/state/DirectLinkProvider';

export default function RootLayout() {
  // useColorScheme can report values outside light/dark; anything else gets dark.
  const scheme: 'light' | 'dark' = useColorScheme() === 'light' ? 'light' : 'dark';

  // Keeps the native root view behind the JS from flashing white in dark mode.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(BACKGROUNDS[scheme]);
  }, [scheme]);

  return (
    <TamaguiProvider config={config} defaultTheme={scheme}>
      <Theme name={scheme}>
        <SafeAreaProvider>
          {/*
            Devices sit inside the link, not beside it: the catalog only exists
            when a server holds it, and whether that is the case is the link's
            business.
          */}
          <DirectLinkProvider>
            <DevicesProvider>
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              {/*
                No tab bar. Root is the device canvas, and everything else is
                pushed on top of it — a device's own screens, the add flow, and
                the app-level infrastructure pages.
              */}
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
              </Stack>
            </DevicesProvider>
          </DirectLinkProvider>
        </SafeAreaProvider>
      </Theme>
    </TamaguiProvider>
  );
}
