import type { ReactNode } from 'react';
import { Text, YStack } from 'tamagui';

import { readingOf, type AttributeSpec, type DeviceInfo, type Reading } from '@kraftverk/device-sdk';

import { Card, SectionLabel } from './Card.tsx';
import { formatValue, isOld } from './measurement.ts';
import { Row, RowSeparator } from './Row.tsx';

/**
 * A part as a card: what it reports, row by row, as its description says. A
 * kit piece — model types in, nothing of the app's — so the generic pages and
 * a package's own screens draw a part the same way.
 */

/** One attribute and what it last said: its label, and its value in its own unit. A value no longer current is drawn quieter. */
export function ReadingRow({ attribute, reading }: { attribute: AttributeSpec; reading: Reading | null }) {
  const quiet = attribute.category === 'diagnostic' || (reading ? isOld(attribute, reading) : false);
  return (
    <Row
      title={attribute.label}
      accessory={
        <Text fontSize={15} fontWeight="700" color={quiet ? '$muted' : '$color'} fontVariant={['tabular-nums']}>
          {formatValue(attribute, reading?.value ?? null)}
        </Text>
      }
    />
  );
}

export function PartCard({
  title,
  attributes,
  readings,
  accessory,
}: {
  title: string;
  attributes: readonly AttributeSpec[];
  readings: readonly Reading[];
  /** Beside the title: a way to the part's own page. */
  accessory?: ReactNode;
}) {
  if (attributes.length === 0) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{title}</SectionLabel>
      <Card inset>
        {attributes.map((attribute, index) => (
          <YStack key={attribute.key}>
            {index > 0 ? <RowSeparator /> : null}
            <ReadingRow attribute={attribute} reading={readingOf(readings, attribute.key)} />
          </YStack>
        ))}
        {accessory ? (
          <>
            <RowSeparator />
            {accessory}
          </>
        ) : null}
      </Card>
    </YStack>
  );
}

/** Names for what a device says about itself. */
const INFO_LABELS: Record<Exclude<keyof DeviceInfo, 'firmware'>, string> = {
  manufacturer: 'Made by',
  model: 'Model',
  modelId: 'Model code',
  serial: 'Serial number',
  hardware: 'Hardware',
};

/** What a device has said about itself — who made it, what it is, its firmware — or nothing, until it has. */
export function InfoCard({ info, title = 'About' }: { info: DeviceInfo | null; title?: string }) {
  const rows = [
    ...(Object.keys(INFO_LABELS) as (keyof typeof INFO_LABELS)[]).flatMap((key) => (info?.[key] ? [{ title: INFO_LABELS[key], value: info[key]! }] : [])),
    ...Object.entries(info?.firmware ?? {}).map(([component, version]) => ({ title: `Firmware${component === 'main' ? '' : `: ${component}`}`, value: version })),
  ];
  if (rows.length === 0) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{title}</SectionLabel>
      <Card inset>
        {rows.map((row, index) => (
          <YStack key={row.title}>
            {index > 0 ? <RowSeparator /> : null}
            <Row
              title={row.title}
              accessory={
                <Text fontSize={14} fontWeight="600" color="$color" userSelect="text">
                  {row.value}
                </Text>
              }
            />
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}
