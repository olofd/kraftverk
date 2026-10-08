import { router } from 'expo-router';
import { Text, useTheme, YStack } from 'tamagui';

import { Card, haptic, Icon, Row, RowSeparator, SectionLabel, ToggleRow } from '@kraftverk/ui';
import { PATHS } from '@kraftverk/api-client';

import { Pressable } from '../../components/Pressable';
import { AddDevice } from '../account/AddDevice';
import { YourAccount } from '../account/YourAccount';
import { Screen } from '../../components/Screen';
import { keepsAccounts } from '../../state/AccountProvider';
import { NotificationSettings } from '../notifications/Notifications';
import { useAuth } from '../../state/AuthProvider';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';
import { useServers } from '../../state/ServersProvider';
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
  const { writesAllowed, allowWrites, role } = useFamily();
  const { active } = useServers();
  const auth = useAuth();
  const theme = useTheme();
  const chevron = <Icon name="chevron-right" size={16} color={theme.muted?.val} />;

  return (
    <Screen back="Your devices" title="App settings" subtitle="You, servers, connectivity and this app">
      {keepsAccounts() ? (
        <>
          <YourAccount />
          <AddDevice />
        </>
      ) : (
        <YStack gap="$2">
          <SectionLabel>You</SectionLabel>
          <Card gap="$2">
            <Text fontSize={14} fontWeight="600" color="$color">
              {auth.state?.user ? `Signed in as ${auth.state.user.username}` : 'Signed in at your server'}
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              This page is plain HTTP, so this browser keeps no account here: you sign in with your server password, and nothing is kept in it. Open kraftverk over HTTPS to keep your account in this browser, sign in by its key, and reach devices from it.
            </Text>
          </Card>
        </YStack>
      )}
      <NotificationSettings />
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
          <Pressable onPress={() => router.push(PATHS.settings.homes)}>
            <Row title="Homes" subtitle="Where your family lives, or spends time: each with its own place and clock" accessory={chevron} />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push(PATHS.settings.zones)}>
            <Row title="Zones" subtitle="Places your family knows that are no home: school, work" accessory={chevron} />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push(PATHS.settings.people)}>
            <Row title="People" subtitle="Who is in your family, and inviting someone" accessory={chevron} />
          </Pressable>
          <RowSeparator />
          {keepsAccounts() ? (
            <>
              <Pressable onPress={() => router.push(PATHS.settings.join)}>
                <Row title="Join a family" subtitle="With an invitation someone sent you" accessory={chevron} />
              </Pressable>
              <RowSeparator />
            </>
          ) : null}
          <Pressable onPress={() => router.push(PATHS.settings.modes)}>
            <Row title="Modes" subtitle="Home, away, vacation; day, evening, night — your own beside them, and one planned ahead" accessory={chevron} />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push(PATHS.settings.labels)}>
            <Row title="Labels" subtitle="Your own groupings — heating, upstairs — to filter your devices by" accessory={chevron} />
          </Pressable>
          <RowSeparator />
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
