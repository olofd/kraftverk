import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider, Theme } from 'tamagui';

import config, { BACKGROUNDS } from '../tamagui.config';
import { StationProvider } from '../src/state/StationProvider';

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
          <StationProvider>
            <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
            </Stack>
          </StationProvider>
        </SafeAreaProvider>
      </Theme>
    </TamaguiProvider>
  );
}
