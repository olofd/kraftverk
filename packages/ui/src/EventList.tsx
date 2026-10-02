import { Text, XStack, YStack } from 'tamagui';

import { MAIN_PART, partsOf, type DeviceDescription, type EventLevel } from '@kraftverk/device-sdk';

import { Card, SectionLabel } from './Card.tsx';
import { formatAgo } from './format.ts';
import { RowSeparator } from './Row.tsx';

/** Something a device said happened, as the kit draws it. */
export type ListedEvent = {
  key: string | number;
  /** Its id, as the description declares it: `mains.lost`. */
  event: string;
  level: EventLevel;
  part: string;
  at: string;
  /** Across devices: whose it was. */
  deviceName?: string;
  deviceId?: string;
};

const LEVEL_COLOUR: Record<EventLevel, string> = { info: '$muted', warn: '$warning', error: '$danger' };

/**
 * What devices said happened, newest first: each by the label its
 * description gives it, the part it happened to, and when. A kit piece — the
 * device page draws one device's, the problems page every device's warnings
 * and errors.
 */
export function EventList({
  title,
  events,
  describe,
  empty,
}: {
  title: string;
  events: readonly ListedEvent[];
  /** The description each event is declared in, by device name or for the one device: its label and its parts'. */
  describe: (event: ListedEvent) => DeviceDescription | null;
  /** Said when there are none; nothing is drawn when absent. */
  empty?: string;
}) {
  if (events.length === 0 && !empty) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{title}</SectionLabel>
      <Card inset>
        {events.length === 0 ? (
          <Text fontSize={13} color="$muted" padding="$4">
            {empty}
          </Text>
        ) : (
          events.map((event, index) => {
            const description = describe(event);
            const spec = description?.events?.find((candidate) => candidate.id === event.event);
            const part = event.part === MAIN_PART ? null : (description ? partsOf(description).find((candidate) => candidate.id === event.part)?.label : null) ?? event.part;
            const where = [event.deviceName, part].filter(Boolean).join(' — ');
            return (
              <YStack key={event.key}>
                {index > 0 ? <RowSeparator /> : null}
                <XStack alignItems="center" gap="$3" paddingHorizontal="$4" paddingVertical="$3">
                  <YStack width={8} height={8} borderRadius={999} backgroundColor={LEVEL_COLOUR[event.level]} aria-label={event.level} />
                  <YStack flex={1} gap={2}>
                    <Text fontSize={15} fontWeight="600" color="$color">
                      {spec?.label ?? event.event}
                    </Text>
                    <Text fontSize={12} color="$muted" lineHeight={17}>
                      {[where, formatAgo(event.at)].filter(Boolean).join(' · ')}
                    </Text>
                  </YStack>
                </XStack>
              </YStack>
            );
          })
        )}
      </Card>
    </YStack>
  );
}
