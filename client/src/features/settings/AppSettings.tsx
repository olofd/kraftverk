import { router } from 'expo-router';
import { Text, useTheme, YStack } from 'tamagui';

import { Card, haptic, Icon, Row, RowSeparator, SectionLabel, ToggleRow } from '@kraftverk/ui';
import { PATHS } from '@kraftverk/api-client';

import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useAuth } from '../../state/AuthProvider';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { useServers } from '../../state/ServersProvider';
import { HomeLocation } from './HomeLocation';
import { HomePolicy } from './HomePolicy';
import { ResetEverything } from './ResetEverything';
import { Servers } from './Servers';

/**
 * The app's own settings, as distinct from a device's: which server, who may
 * use it, what it and this app can reach devices over, and what this app may
 * do itself. None of it is a thing you have, so none of it sits on the device
 * canvas.
 */
export function AppSettings() {
  const { version, removed } = useDevices();
  const { writesAllowed, allowWrites, role } = useHome();
  const { active } = useServers();
  const auth = useAuth();
  const theme = useTheme();
  const chevron = <Icon name="chevron-right" size={16} color={theme.muted?.val} />;

  return (
    <Screen back="Your devices" title="App settings" subtitle="Servers, connectivity and this app">
      <YStack gap="$2">
        <SectionLabel>Infrastructure</SectionLabel>
        <Card inset>
          {active ? (
            <>
              <Pressable onPress={() => router.push(PATHS.settings.accounts)}>
                <Row
                  title="Accounts"
                  subtitle={auth.state?.user ? `Signed in as ${auth.state.user.username}. Who may use this server.` : 'Who may use this server'}
                  accessory={chevron}
                />
              </Pressable>
              <RowSeparator />
            </>
          ) : null}
          <Pressable onPress={() => router.push(PATHS.settings.connectivity)}>
            <Row
              title="Connectivity"
              subtitle={role === 'follower' ? 'Your kraftverk nodes — your server and this app — what each reaches devices over, and their diagnostics' : 'This kraftverk node, and what it reaches devices over'}
              accessory={chevron}
            />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push(PATHS.devices.removed)}>
            <Row title="Removed devices" subtitle={removed.length ? `${removed.length} kept with their history` : 'None'} accessory={chevron} />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push(PATHS.settings.configuration())}>
            <Row title="Configuration" subtitle={active ? 'Your home as one file: export it, import one, and the copy kept beside the server' : 'Your home as one file: export it, and import one'} accessory={chevron} />
          </Pressable>
          {active ? (
            <>
              <RowSeparator />
              <Pressable onPress={() => router.push(PATHS.settings.maps)}>
                <Row title="Maps" subtitle="The map your server holds: the world, and the countries you download — before a journey, say" accessory={chevron} />
              </Pressable>
              <RowSeparator />
              <Pressable onPress={() => router.push(PATHS.settings.serverLog)}>
                <Row title="Server log" subtitle="What the server has said lately — where to look when something is wrong" accessory={chevron} />
              </Pressable>
            </>
          ) : null}
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>This app</SectionLabel>
        <Card inset>
          {/*
            Off on every launch, on purpose: a phone in a pocket should not be
            the easiest way to change a device's settings or switch its power.
          */}
          <ToggleRow
            title="Allow writes from this app"
            subtitle="For devices this app holds itself. Off every time the app starts: until then, it only reads."
            checked={writesAllowed}
            onCheckedChange={(next) => {
              haptic();
              void allowWrites(next);
            }}
          />
        </Card>
      </YStack>

      <HomePolicy />

      <HomeLocation />

      <Servers />

      <YStack gap="$2">
        <SectionLabel>This install</SectionLabel>
        <Card inset>
          <Row
            title="Where your home is kept"
            subtitle={role === 'follower' ? 'On your server: always on, it keeps your devices, their history and their automations, and this app follows it' : 'In this app: it keeps your devices, their history and their automations — while it is open'}
            accessory={
              <Text fontSize={13} color="$muted">
                {role === 'follower' ? 'Your server' : 'This app'}
              </Text>
            }
          />
          {active ? (
            <>
              <RowSeparator />
              <Row
                title="Server version"
                subtitle={active?.url}
                accessory={
                  <Text fontSize={13} color="$muted">
                    {version ? `v${version.version}` : '—'}
                  </Text>
                }
              />
            </>
          ) : null}
        </Card>
      </YStack>

      {active ? <ResetEverything /> : null}
    </Screen>
  );
}
