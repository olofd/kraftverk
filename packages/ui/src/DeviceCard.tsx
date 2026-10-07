import type { ReactNode } from 'react';
import { Image, type ImageSourcePropType } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { AttributeSpec, ConnectionHealth, Reading } from '@kraftverk/device-sdk';
import { isOnline, readingOf } from '@kraftverk/device-sdk';

import { Card } from './Card.tsx';
import { haptic } from './haptics.ts';
import { formatValue, isOld, observedAt, shownAttributes } from './measurement.ts';

/**
 * One device, as a card.
 *
 * There is exactly one of these, and it is written against descriptions rather
 * than against any particular device: a name, an icon, the attributes of its
 * main part, and what it last read. A station and a plug differ only in what they declared,
 * which is the point — the grid stops needing new code the moment a device
 * type starts providing something new.
 *
 * Offline is drawn, not hidden. A device you own that is unplugged is greyed
 * with its last state and a reason, because a card that vanishes is a card that
 * cannot tell you anything went wrong.
 */

export type DeviceCardDevice = {
  name: string;
  /** A line under the name: its model. */
  subtitle?: string;
  health: ConnectionHealth;
  /** The attributes it leads with: its main part's. */
  attributes: readonly AttributeSpec[];
  readings: readonly Reading[];
};

/**
 * The dot's colour, by state.
 *
 * `connecting` is amber rather than green because a card that goes green while
 * it is still trying is a card that has lied once already, and `error` is red
 * where `offline` is grey: an unplugged device is not a fault.
 */
export const HEALTH_DOT: Record<ConnectionHealth['status'], string> = {
  connected: '$success',
  connecting: '$warning',
  offline: '$muted',
  unconfigured: '$muted',
  error: '$danger',
  // Waiting on a person: amber, and its sentence says what to do.
  'needs-you': '$warning',
  paused: '$muted',
};

type Props = {
  device: DeviceCardDevice;
  /** Supplied by the app: this package has no icon set of its own. */
  icon?: ReactNode;
  /** The device as it looks, from its package: drawn small, in place of the icon. */
  image?: ImageSourcePropType | null;
  /** Up to two more attributes under the headline. */
  secondary?: readonly AttributeSpec[];
  onPress?: () => void;
};

export function DeviceCard({ device, icon, image, secondary, onPress }: Props) {
  const online = isOnline(device.health);
  const [primary, ...rest] = shownAttributes(device.attributes);
  const primaryReading = primary ? readingOf(device.readings, primary.key) : null;
  const primaryValue = primary ? formatValue(primary, primaryReading?.value ?? null) : '—';
  // Its attribute says how long a value stays current: past that it is shown as it was, and when.
  const primaryOld = primary ? isOld(primary, primaryReading) : false;

  const extras = (secondary ?? rest.slice(0, 2)).map((spec) => {
    const reading = readingOf(device.readings, spec.key);
    return { spec, text: formatValue(spec, reading?.value ?? null), old: isOld(spec, reading) };
  });

  return (
    <Card
      gap="$3"
      // Dimmed rather than dropped: the device is still yours, it is just quiet.
      opacity={online ? 1 : 0.55}
      /*
        A tappable card is a button. It was a plain div with a click handler, so
        on the web a keyboard could not reach any device at all — opening one is
        the primary navigation of this app, and Tab skipped every card on the
        canvas. The role is what earns Enter and Space from react-native-web;
        the focus ring is what makes the reached card visible.

        The label is spelled out because the card's own text is a name followed
        by bare numbers, which a screen reader would otherwise read as the whole
        button title.
      */
      role={onPress ? 'button' : undefined}
      tabIndex={onPress ? 0 : undefined}
      aria-label={onPress ? `${device.name}, ${device.health.detail}` : undefined}
      cursor={onPress ? 'pointer' : undefined}
      pressStyle={onPress ? { opacity: 0.75 } : undefined}
      focusVisibleStyle={
        onPress ? { outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' } : undefined
      }
      onPress={
        onPress
          ? () => {
              haptic();
              onPress();
            }
          : undefined
      }
    >
      <XStack alignItems="flex-start" justifyContent="space-between" gap="$3">
        <XStack alignItems="center" gap="$2.5" flex={1}>
          {image ? (
            // Small, where the icon would be: in a list the picture says which device, not anything about it.
            <Image source={image} resizeMode="contain" style={{ width: 36, height: 36 }} accessibilityIgnoresInvertColors />
          ) : (
            icon
          )}
          <YStack flex={1} gap={2}>
            <Text fontSize={16} fontWeight="700" color="$color" numberOfLines={1}>
              {device.name}
            </Text>
            {device.subtitle ? (
              <Text fontSize={12} color="$muted" numberOfLines={1}>
                {device.subtitle}
              </Text>
            ) : null}
          </YStack>
        </XStack>
        <YStack
          width={8}
          height={8}
          borderRadius={999}
          marginTop={6}
          backgroundColor={HEALTH_DOT[device.health.status]}
        />
      </XStack>

      {/* A wide reading ("0.59 SEK/kWh") leaves no room beside it on a phone: what is read beside it moves below, never past the card's edge. */}
      <XStack alignItems="flex-end" justifyContent="space-between" columnGap="$3" rowGap="$2" flexWrap="wrap">
        <YStack gap={2}>
          <Text fontSize={30} fontWeight="800" letterSpacing={-1} color={primaryOld ? '$muted' : '$color'}>
            {primaryValue}
          </Text>
          {primary ? (
            <Text fontSize={11} color="$muted" textTransform="uppercase" letterSpacing={0.6}>
              {primaryOld && primaryReading ? `${primary.label}, as of ${observedAt(primaryReading.at)}` : primary.label}
            </Text>
          ) : null}
        </YStack>

        {extras.length > 0 ? (
          <YStack alignItems="flex-end" gap={3} flexGrow={1}>
            {extras.map(({ spec, text, old }) => (
              <XStack key={spec.key} alignItems="baseline" gap="$2">
                <Text fontSize={11} color="$muted">
                  {spec.label}
                </Text>
                <Text fontSize={13} fontWeight="600" color={old ? '$muted' : '$color'}>
                  {text}
                </Text>
              </XStack>
            ))}
          </YStack>
        ) : null}
      </XStack>

      {online ? null : (
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {device.health.detail}
        </Text>
      )}
    </Card>
  );
}
