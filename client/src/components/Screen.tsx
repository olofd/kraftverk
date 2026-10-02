import type { ReactNode } from 'react';
import { RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { ScrollView, Text, useTheme, XStack, YStack } from 'tamagui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@kraftverk/ui';

import { useDevices } from '../state/DevicesProvider';
import { ConnectionBanner } from './ConnectionBanner';

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
  /** Beside the title, on the right: the device's picture. The status then sits under the title. */
  aside?: ReactNode;
  children: ReactNode;
  /**
   * Kept below the page, not scrolled with it: what a form saves with — Cancel
   * and Save, and whether it can be saved — always in reach.
   */
  footer?: ReactNode;
};

/**
 * Shared page chrome: safe-area padding, a centred max-width column so the web
 * build doesn't stretch to 2000px, pull-to-refresh, and the offline banner.
 */
export function Screen({ title, subtitle, back, backTo, status, aside, children, footer }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { homeReach, refresh, views } = useDevices();
  /*
    A screen's own status — a device's health, in its own words, which can be
    a whole error — goes under the title, where it has the width to wrap. On
    the right it took the width, and squeezed the title to a letter a line.
    The app's own Online, short, stays on the right.
  */
  const statusBelow = Boolean(aside || status);

  const page = (
    <ScrollView
      flex={1}
      // A touch says someone is using the app: the server keeps reading what it shows more often.
      onTouchStart={() => views.used()}
      backgroundColor="$background"
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
        alignItems: 'center',
      }}
      refreshControl={
        <RefreshControl
          refreshing={homeReach === 'connecting'}
          onRefresh={() => void refresh()}
          tintColor={theme.muted?.val}
        />
      }
    >
      <YStack width="100%" maxWidth={560} gap="$4">
        {back ? (
          // The way back, as navigation: reachable by Tab, operable by Enter, and a landmark to jump to.
          <XStack role="navigation" aria-label="Back" alignSelf="flex-start">
            <XStack
              role="button"
              tabIndex={0}
              aria-label={`Back to ${back}`}
              alignItems="center"
              gap="$1.5"
              minHeight={44}
              cursor="pointer"
              pressStyle={{ opacity: 0.6 }}
              focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
              onPress={() =>
                router.canGoBack() ? router.back() : router.replace(backTo ?? '/')
              }
            >
              <Icon name="chevron-left" size={16} color={theme.muted?.val} />
              <Text fontSize={14} fontWeight="600" color="$muted">
                {back}
              </Text>
            </XStack>
          </XStack>
        ) : null}

        <XStack alignItems={aside ? 'center' : 'flex-end'} justifyContent="space-between" gap="$3">
          {/* The title takes what is left and wraps: a long name must not push the status off the screen. */}
          <YStack gap={2} flex={1} flexShrink={1}>
            <Text role="heading" aria-level={1} fontSize={30} lineHeight={34} fontWeight="800" letterSpacing={-0.8} color="$color">
              {title}
            </Text>
            {subtitle ? (
              <Text fontSize={14} color="$muted">
                {subtitle}
              </Text>
            ) : null}
            {statusBelow ? (
              <XStack marginTop="$2">
                <StatusDot status={status} />
              </XStack>
            ) : null}
          </YStack>
          {aside ?? (statusBelow ? null : <StatusDot status={status} />)}
        </XStack>

        <ConnectionBanner />

        {/* What the screen is about: the landmark a screen reader goes to first. */}
        <YStack role="main" gap="$4">
          {children}
        </YStack>
      </YStack>
    </ScrollView>
  );
  if (!footer) return page;
  return (
    <YStack flex={1} backgroundColor="$background">
      {page}
      <YStack borderTopWidth={1} borderColor="$borderColor" backgroundColor="$card" paddingHorizontal={16} paddingTop={12} paddingBottom={insets.bottom + 12} alignItems="center">
        <YStack width="100%" maxWidth={560}>
          {footer}
        </YStack>
      </YStack>
    </YStack>
  );
}

/**
 * What is being reported, and by whom.
 *
 * By default this is the home's reach: whether the server it follows
 * answers — or, keeping its own home, that home. On a screen that is *about one device* that
 * is the wrong subject — a reachable server happily reports "Online" beside a
 * station that has never connected — so those screens pass the device's state
 * instead.
 */
/** What a status dot shows: being reached, reached, not reached, or — a device not set to be — not trying. */
export type StatusTone = 'connecting' | 'online' | 'offline' | 'idle';

export type ScreenStatus = { tone: StatusTone; label?: string };

function StatusDot({ status }: { status?: ScreenStatus }) {
  const { homeReach } = useDevices();
  const connection: StatusTone = status?.tone ?? homeReach;

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
    <XStack alignItems="center" gap="$2" paddingBottom={6} flexShrink={1}>
      <YStack width={8} height={8} borderRadius={999} backgroundColor={color} flexShrink={0} />
      {/* Two lines at most: the whole of a long one is on the page below. */}
      <Text fontSize={12} fontWeight="600" color="$muted" flexShrink={1} numberOfLines={2}>
        {label}
      </Text>
    </XStack>
  );
}
