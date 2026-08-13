import type { ReactNode } from 'react';
import { router } from 'expo-router';
import { Card, haptic } from '@kraftverk/ui';
import { Spinner, Text, XStack, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';

import { Screen } from '../../components/Screen';
import { useDevice, useDevices } from '../../state/DevicesProvider';

/**
 * The frame around one device.
 *
 * Two primary destinations and no more: **Dashboard** is what it is doing,
 * **Settings** is what it remembers and what you can change. Everything the app
 * used to show as a global tab — the station's dashboard, its settings, its
 * register diagnostics — is one of these for one device, because a tab bar with
 * "Dashboard" in it is a claim that one device is the application.
 *
 * They are real routes rather than local state, so a device can be bookmarked,
 * pinned or opened directly, and so the back button behaves.
 */

export type DeviceTab = 'dashboard' | 'settings';

const TABS: { value: DeviceTab; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'settings', label: 'Settings' },
];

/**
 * The device's own two-item navigation.
 *
 * Deliberately not the shared `SegmentedControl`: that one is a settings *row*,
 * with a title and a description above it. This is navigation, and it carries
 * no label because the screen title above it already says whose device it is.
 */
function DeviceTabs({ tab, onChange }: { tab: DeviceTab; onChange: (next: DeviceTab) => void }) {
  return (
    <XStack backgroundColor="$backgroundPress" borderRadius="$3" padding={3} gap={3} role="tablist">
      {TABS.map((option) => {
        const selected = option.value === tab;
        return (
          <XStack
            key={option.value}
            flex={1}
            role="tab"
            aria-selected={selected}
            justifyContent="center"
            paddingVertical="$2"
            borderRadius="$2"
            cursor="pointer"
            backgroundColor={selected ? '$card' : 'transparent'}
            hoverStyle={selected ? undefined : { backgroundColor: '$backgroundHover' }}
            pressStyle={{ opacity: 0.7 }}
            onPress={() => {
              if (selected) return;
              haptic();
              onChange(option.value);
            }}
          >
            <Text
              fontSize={13}
              fontWeight={selected ? '700' : '500'}
              color={selected ? '$color' : '$muted'}
            >
              {option.label}
            </Text>
          </XStack>
        );
      })}
    </XStack>
  );
}

export function DeviceShell({
  id,
  tab,
  children,
}: {
  id: string | undefined;
  tab: DeviceTab;
  children: (device: DeviceView) => ReactNode;
}) {
  const device = useDevice(id);
  const { loading } = useDevices();

  if (!device) {
    return (
      <Screen back="Your devices" title="Device">
        <Card>
          <YStack padding="$5" alignItems="center" gap="$3">
            {loading ? (
              <Spinner color="$accent" />
            ) : (
              <Text fontSize={13} color="$muted" textAlign="center" lineHeight={19}>
                That device is no longer in the list. It may have been removed.
              </Text>
            )}
          </YStack>
        </Card>
      </Screen>
    );
  }

  const path = `/device/${encodeURIComponent(device.id)}`;

  return (
    <Screen
      back="Your devices"
      title={device.record.name}
      subtitle={device.description}
      /*
        This device's state, not the app's. A reachable server was reporting
        "Online" above a station that had never connected — the header was
        answering a question nobody on this screen was asking.
      */
      status={{
        connection: device.online ? 'online' : 'idle',
        label: device.online ? 'Online' : (device.detail ?? 'Not connected'),
      }}
    >
      <DeviceTabs
        tab={tab}
        onChange={(next) =>
          // Replace, not push: the two tabs are one destination, and pushing
          // would make Back walk through every tab the user glanced at.
          router.replace(next === 'dashboard' ? path : `${path}/settings`)
        }
      />
      {children(device)}
    </Screen>
  );
}
