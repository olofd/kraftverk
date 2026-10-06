import type { ReactNode } from 'react';
import { Redirect, router } from 'expo-router';
import { Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { ConnectionStatus } from '@kraftverk/device-sdk';
import type { DeviceView } from '@kraftverk/api-client';
import { Card, haptic } from '@kraftverk/ui';

import { Screen } from '../../components/Screen';
import type { StatusTone } from '../../components/Screen';
import { useDevice, useDevices } from '../../state/DevicesProvider';
import { useShowing } from '../../state/useShowing';
import { accountPath } from '../integrations/IntegrationScreen';
import { DevicePicture } from './DevicePicture';
import { pictureFor } from './registry';

/**
 * A device's health, as the header's one dot. Five states collapse into four
 * colours, and the label beside the dot is always the health's own sentence.
 */
const DOT: Record<ConnectionStatus, StatusTone> = {
  connected: 'online',
  connecting: 'connecting',
  offline: 'idle',
  unconfigured: 'idle',
  error: 'offline',
  'needs-you': 'connecting',
  paused: 'idle',
};

/** The header status for any screen about one device: that device's health, not the server's. */
export const deviceStatus = (device: DeviceView) => ({
  tone: DOT[device.health.status],
  label: device.health.detail,
});

export type DeviceTab = 'dashboard' | 'settings';

const TABS: { value: DeviceTab; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'settings', label: 'Settings' },
];

/** The device's own two-item navigation. */
function DeviceTabs({ tab, onChange }: { tab: DeviceTab; onChange: (next: DeviceTab) => void }) {
  /*
    The resolved value, not the token. Written inline as a conditional,
    `backgroundColor="$card"` resolves against a baked-in default rather than
    the theme, and in the light theme paints a dark slate behind the near-black
    selected label.
  */
  const theme = useTheme();

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
            backgroundColor={selected ? theme.card?.val : 'transparent'}
            hoverStyle={selected ? undefined : { backgroundColor: '$backgroundHover' }}
            pressStyle={{ opacity: 0.7 }}
            onPress={() => {
              if (selected) return;
              haptic();
              onChange(option.value);
            }}
          >
            <Text fontSize={13} fontWeight={selected ? '700' : '500'} color={selected ? '$color' : '$muted'}>
              {option.label}
            </Text>
          </XStack>
        );
      })}
    </XStack>
  );
}

/**
 * The frame around one device: **Dashboard** is what it is doing, **Settings**
 * is what it remembers, how it is reached and how it fits the house. Real
 * routes, so a device can be bookmarked and the back button behaves.
 */
export function DeviceShell({ id, tab, children }: { id: string | undefined; tab: DeviceTab; children: (device: DeviceView) => ReactNode }) {
  const device = useDevice(id);
  const { loading } = useDevices();
  // Every page of a device shows it: while one is in front, the server reads it more often.
  useShowing(device ? [{ kind: 'device', id: device.id }] : []);

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

  // An account is its integration's, and has its page there (docs/PLAN-INTEGRATIONS.md §1.1).
  if (device.kind === 'account' && device.integration && !device.removedAt) return <Redirect href={accountPath(device.integration.id, device.id)} />;

  const path = `/device/${encodeURIComponent(device.id)}`;

  return (
    <Screen
      back="Your devices"
      title={device.name}
      subtitle={device.meta.name}
      status={deviceStatus(device)}
      aside={pictureFor(device.typeId) ? <DevicePicture device={device} /> : undefined}
    >
      {device.removedAt ? null : (
        <DeviceTabs
          tab={tab}
          // Replace, not push: the two tabs are one destination.
          onChange={(next) => router.replace(next === 'dashboard' ? path : `${path}/settings`)}
        />
      )}
      {children(device)}
    </Screen>
  );
}
