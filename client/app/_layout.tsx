import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { TamaguiProvider, Theme } from "tamagui";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmHost } from "../src/components/ConfirmHost";
import { AccountProvider } from "../src/state/AccountProvider";
import { AuthGate } from "../src/features/auth/AuthGate";
import { AuthProvider } from "../src/state/AuthProvider";
import { DevicesProvider } from "../src/state/DevicesProvider";
import { FamilyProvider } from "../src/state/FamilyProvider";
import { ServerMap } from "../src/state/ServerMap";
import { ServersProvider } from "../src/state/ServersProvider";
import config, { BACKGROUNDS } from "../tamagui.config";

export default function RootLayout() {
  // useColorScheme can report values outside light/dark; anything else gets dark.
  const scheme: "light" | "dark" =
    useColorScheme() === "light" ? "light" : "dark";

  // Keeps the native root view behind the JS from flashing white in dark mode.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(BACKGROUNDS[scheme]);
  }, [scheme]);

  return (
    <TamaguiProvider config={config} defaultTheme={scheme}>
      <Theme name={scheme}>
        <SafeAreaProvider>
          {/* Which server, if any, comes first: everything else depends on it. */}
          <ServersProvider>
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            {/*
              Who uses this device comes first: an account, made here with no
              server, or one this device keeps. Everything after is theirs.
            */}
            <AccountProvider>
            {/*
              Who you are to the chosen server comes before anything that asks
              it for data. Behind the gate, the device list never starts polling
              a server that will only answer "log in first".
            */}
            <AuthProvider>
              <AuthGate>
                {/* The home the app shows: a server's, or its own — one interface either way. */}
                <FamilyProvider>
                  <ServerMap>
                    <DevicesProvider>
                      {/*
                      No tab bar. Root is the device canvas, and everything else is
                      pushed on top of it — a device's own screens, the add flow, and
                      the app-level infrastructure pages.
                    */}
                      <Stack screenOptions={{ headerShown: false }}>
                        <Stack.Screen name="index" />
                      </Stack>
                    </DevicesProvider>
                  </ServerMap>
                </FamilyProvider>
              </AuthGate>
            </AuthProvider>
            </AccountProvider>
            {/* Where the app asks for a yes, on the web: above every screen, signed in or not. */}
            <ConfirmHost />
          </ServersProvider>
        </SafeAreaProvider>
      </Theme>
    </TamaguiProvider>
  );
}
