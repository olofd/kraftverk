import { Text, useTheme, XStack, YStack } from 'tamagui';

import { partIcon, type DeviceDescription, type Reading } from '@kraftverk/device-sdk';

import { Card, SectionLabel } from './Card';
import { energyFlowOf, type FlowNode } from './energy';
import { formatWatts } from './format';
import { Icon } from './Icon';

/**
 * Where a device's energy comes from, where it is kept and where it goes —
 * sources, storage and loads, each a part with an energy role, drawn for any
 * device from its description and readings. A package with a flow of its own
 * (the station's animated one) overrides the dashboard; everything else gets
 * this with no code of its own.
 */
export function EnergyFlow({
  description,
  readings,
  mainLabel,
  fedBy = {},
  feeds = {},
}: {
  description: DeviceDescription;
  readings: readonly Reading[];
  mainLabel?: string;
  /** What feeds a part, as the house's links say, by the part's id: "Charger plug". */
  fedBy?: Readonly<Record<string, string>>;
  /** What a part feeds, by the part's id: "Garage station — Mains". */
  feeds?: Readonly<Record<string, string>>;
}) {
  const theme = useTheme();
  const flow = energyFlowOf(description, readings, mainLabel);
  if (!flow) return null;
  const columns = [
    { role: 'source', title: 'From', nodes: flow.source },
    { role: 'storage', title: 'Kept', nodes: flow.storage },
    { role: 'load', title: 'To', nodes: flow.load },
  ].filter((column) => column.nodes.length > 0);
  // One part alone, joined to nothing, is not a flow: its figures are on the card above.
  const linked = Object.keys(fedBy).length + Object.keys(feeds).length > 0;
  if (columns.length < 2 && !linked) return null;

  const node = (item: FlowNode) => {
    const active = (item.watts ?? 0) > 0;
    const figure = item.part.energy?.role === 'storage' ? (item.soc === null ? '—' : `${Math.round(item.soc)} %`) : item.watts === null ? '—' : formatWatts(item.watts);
    return (
      <YStack key={item.part.id} alignItems="center" gap={4} paddingVertical="$2" minWidth={72}>
        <Icon
          name={partIcon(item.part) as never}
          size={18}
          color={active || item.part.energy?.role === 'storage' ? theme.accent?.val : theme.muted?.val}
        />
        <Text fontSize={12} color="$muted" textAlign="center" numberOfLines={2}>
          {item.part.label}
        </Text>
        <Text fontSize={14} fontWeight="700" color={active ? '$color' : '$muted'} fontVariant={['tabular-nums']}>
          {figure}
        </Text>
        {fedBy[item.part.id] ? (
          <Text fontSize={11} color="$muted" textAlign="center">
            from {fedBy[item.part.id]}
          </Text>
        ) : null}
        {feeds[item.part.id] ? (
          <Text fontSize={11} color="$muted" textAlign="center">
            to {feeds[item.part.id]}
          </Text>
        ) : null}
      </YStack>
    );
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Energy</SectionLabel>
      <Card>
        <XStack alignItems="center" justifyContent="space-around" gap="$2">
          {columns.map((column, index) => (
            <XStack key={column.role} alignItems="center" gap="$2" flex={1} justifyContent="space-around">
              {index > 0 ? <Icon name="arrow-right" size={16} color={theme.muted?.val} aria-hidden /> : null}
              <YStack alignItems="center" gap="$1" flex={1}>
                <Text fontSize={11} fontWeight="700" color="$muted" letterSpacing={0.4}>
                  {column.title.toUpperCase()}
                </Text>
                {column.nodes.map(node)}
              </YStack>
            </XStack>
          ))}
        </XStack>
      </Card>
    </YStack>
  );
}
