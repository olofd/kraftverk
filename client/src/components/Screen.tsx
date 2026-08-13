import type { ReactNode } from 'react';
import { RefreshControl } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView, Text, useTheme, XStack, YStack } from 'tamagui';

import { ConnectionBanner } from './ConnectionBanner';
import { useDevices } from '../state/DevicesProvider';
import type { Connection } from '../state/DirectLinkProvider';

type Props = {
  title: string;
  subtitle?: string;
  /** Pushed screens get a way back. Root has none, because it is the root. */
  back?: string;
  /**
   * Where back goes when there is no history to pop.
   *
   * These screens are reachable by deep link and by refresh, where `back()`
   * would strand the user. Without this the label lied: Advanced said
   * "Settings" and landed you on the device canvas.
   */
  backTo?: string;
  /** Overrides the header status, for screens that are about one device. */
  status?: ScreenStatus;
  children: ReactNode;
};

/**
 * Shared page chrome: safe-area padding, a centred max-width column so the web
 * build doesn't stretch to 2000px, pull-to-refresh, and the offline banner.
 */
export function Screen({ title, subtitle, back, backTo, status, children }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { connection, refresh } = useDevices();

  return (
    <ScrollView
      flex={1}
      backgroundColor="$background"
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
        alignItems: 'center',
      }}
      refreshControl={
        <RefreshControl
          refreshing={connection === 'connecting'}
          onRefresh={() => void refresh()}
          tintColor={theme.muted?.val}
        />
      }
    >
      <YStack width="100%" maxWidth={560} gap="$4">
        {back ? (
          <XStack
            alignItems="center"
            gap="$1.5"
            alignSelf="flex-start"
            cursor="pointer"
            pressStyle={{ opacity: 0.6 }}
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace(backTo ?? '/')
            }
          >
            <Feather name="chevron-left" size={16} color={theme.muted?.val} />
            <Text fontSize={14} fontWeight="600" color="$muted">
              {back}
            </Text>
          </XStack>
        ) : null}

        <XStack alignItems="flex-end" justifyContent="space-between" gap="$3">
          <YStack gap={2}>
            <Text fontSize={30} fontWeight="800" letterSpacing={-0.8} color="$color">
              {title}
            </Text>
            {subtitle ? (
              <Text fontSize={14} color="$muted">
                {subtitle}
              </Text>
            ) : null}
          </YStack>
          <StatusDot status={status} />
        </XStack>

        <ConnectionBanner />

        {children}
      </YStack>
    </ScrollView>
  );
}

/**
 * What is being reported, and by whom.
 *
 * By default this is the app's own reachability: can it get to the server, or
 * to the station it holds itself. On a screen that is *about one device* that
 * is the wrong subject — a reachable server happily reports "Online" beside a
 * station that has never connected — so those screens pass the device's state
 * instead.
 */
export type ScreenStatus = { connection: Connection; label?: string };

function StatusDot({ status }: { status?: ScreenStatus }) {
  const { connection: appConnection } = useDevices();
  const connection = status?.connection ?? appConnection;

  const color =
    connection === 'online'
      ? '$success'
      : connection === 'connecting'
        ? '$warning'
        : connection === 'idle'
          ? '$muted'
          : '$danger';
  const label =
    status?.label ??
    (connection === 'online'
      ? 'Online'
      : connection === 'connecting'
        ? 'Connecting'
        : connection === 'idle'
          ? 'Not connected'
          : 'Offline');

  return (
    <XStack alignItems="center" gap="$2" paddingBottom={6}>
      <YStack width={8} height={8} borderRadius={999} backgroundColor={color} />
      <Text fontSize={12} fontWeight="600" color="$muted">
        {label}
      </Text>
    </XStack>
  );
}
