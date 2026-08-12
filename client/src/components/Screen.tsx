import type { ReactNode } from 'react';
import { RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView, Text, useTheme, XStack, YStack } from 'tamagui';

import { ConnectionBanner } from './ConnectionBanner';
import { useStation } from '../state/StationProvider';

type Props = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

/**
 * Shared page chrome: safe-area padding, a centred max-width column so the web
 * build doesn't stretch to 2000px, pull-to-refresh, and the offline banner.
 */
export function Screen({ title, subtitle, children }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { connection, refresh } = useStation();

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
          <StatusDot />
        </XStack>

        <ConnectionBanner />

        {children}
      </YStack>
    </ScrollView>
  );
}

function StatusDot() {
  const { connection } = useStation();

  const color =
    connection === 'online'
      ? '$success'
      : connection === 'connecting'
        ? '$warning'
        : connection === 'idle'
          ? '$muted'
          : '$danger';
  const label =
    connection === 'online'
      ? 'Online'
      : connection === 'connecting'
        ? 'Connecting'
        : connection === 'idle'
          ? 'Not connected'
          : 'Offline';

  return (
    <XStack alignItems="center" gap="$2" paddingBottom={6}>
      <YStack width={8} height={8} borderRadius={999} backgroundColor={color} />
      <Text fontSize={12} fontWeight="600" color="$muted">
        {label}
      </Text>
    </XStack>
  );
}
