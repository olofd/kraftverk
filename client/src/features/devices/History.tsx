import { useState } from 'react';
import { YStack } from 'tamagui';

import type { AttributeSpec, DeviceView } from '@kraftverk/api-client';
import { keepsHistory, MAIN_PART, partsOf } from '@kraftverk/device-sdk';
import { Card, Chips, SectionLabel } from '@kraftverk/ui';

import { MeasurementChart } from './MeasurementChart';

/**
 * One chart, and a way to point it at any number the device keeps. The home
 * records every attribute its description says to keep — whoever holds it — so
 * the picker is simply that list.
 */
export function History({ device, part }: { device: DeviceView; part?: string }) {
  const chartable = device.description.attributes.filter(
    (attribute) => attribute.value.type === 'number' && keepsHistory(attribute) && (part === undefined || (attribute.part ?? MAIN_PART) === part)
  );
  const [key, setKey] = useState<string | null>(null);
  const selected: AttributeSpec | undefined =
    chartable.find((spec) => spec.key === key) ?? chartable.find((spec) => spec.category === 'primary') ?? chartable[0];
  if (!selected) return null;
  const parts = new Map(partsOf(device.description, device.name).map((part) => [part.id, part]));
  const label = (spec: AttributeSpec) => (spec.part && spec.part !== MAIN_PART && !spec.label.startsWith(parts.get(spec.part)?.label ?? '') ? `${parts.get(spec.part)?.label}: ${spec.label}` : spec.label);

  return (
    <YStack gap="$2">
      <SectionLabel>History</SectionLabel>
      <Card gap="$3">
        <Chips label="Show" options={chartable.map((spec) => ({ value: spec.key, label: label(spec) }))} value={selected.key} onChange={setKey} />
        <MeasurementChart deviceId={device.id} measurement={selected} />
      </Card>
    </YStack>
  );
}
