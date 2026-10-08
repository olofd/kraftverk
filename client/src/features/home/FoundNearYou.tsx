import { useState } from 'react';
import { router, useIsFocused } from 'expo-router';
import { useTheme, XStack, YStack } from 'tamagui';

import { PATHS, type FoundView } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { useAnswer } from '../../components/useAnswer';
import { useAuth } from '../../state/AuthProvider';
import { useFamily } from '../../state/FamilyProvider';
import { pictureFor } from '../devices/registry';

/** How often what is near is looked at again, while the home page is seen. */
const LOOK_AGAIN_MS = 10_000;
/** From this many found behind one bridge, they are one row: the home page is not where a family's devices are listed one by one. */
const GROUP_FROM = 4;

/** Where something was found, as the home names it: its transport and address, and the bridge it is behind. */
const foundAt = (entry: FoundView) => ({ transport: entry.transport, through: entry.through?.id ?? null, address: entry.address });

/**
 * What the home's transports can see, and its accounts and gateways have
 * behind them, that nothing you have is reached by: a station that connected
 * to its broker, a plug broadcasting on the network, a scooter on an account.
 * Choosing one skips straight to checking it. One that is not yours can be
 * ignored: it is listed apart, and can be offered again.
 */
export function FoundNearYou() {
  const { api } = useFamily();
  const theme = useTheme();
  const { allowed } = useAuth();
  const [showIgnored, setShowIgnored] = useState(false);
  const [asked, setAsked] = useState(0);
  // The home page stays under every page opened from it: it looks for what is near only while it is seen.
  const seen = useIsFocused();
  const all = useAnswer(() => api.nearby(), [api, asked], { every: LOOK_AGAIN_MS, when: allowed && seen }).value ?? [];
  const found = all.filter((entry) => !entry.ignored);
  const ignored = all.filter((entry) => entry.ignored);

  if (all.length === 0) return null;

  const ignore = async (entry: FoundView, again: boolean) => {
    haptic();
    await (again ? api.unignoreFound(foundAt(entry)) : api.ignoreFound(foundAt(entry)));
    setAsked((count) => count + 1);
  };

  const row = (entry: FoundView, index: number, again: boolean) => {
    const first = entry.types[0]!;
    const add = () =>
      router.push(PATHS.add(first.typeId, { method: first.methodId, address: entry.address, ...(entry.through ? { through: entry.through.id } : {}) }));
    return (
      <YStack key={`${entry.transport}-${entry.through?.id ?? ''}-${entry.address}`}>
        {index > 0 ? <RowSeparator /> : null}
        {/* Two buttons side by side, never one inside the other: adding it, and saying it is not yours. */}
        <XStack alignItems="center">
          <YStack flex={1}>
            <Pressable onPress={add}>
              <Row
                leading={
                  // Its picture only when it is known what it is: one model's picture on "one of several plugs" would be a guess drawn as a fact.
                  entry.types.length === 1 && pictureFor(first.typeId) ? (
                    <DeviceImage typeId={first.typeId} size={36} />
                  ) : (
                    <YStack width={36} height={36} alignItems="center" justifyContent="center">
                      <Icon name="help-circle" size={20} color={theme.muted?.val} />
                    </YStack>
                  )
                }
                title={entry.name}
                subtitle={`${first.name}${entry.types.length > 1 ? ` or ${entry.types.length - 1} more` : ''} · ${entry.detail ?? entry.address}`}
                accessory={<Icon name="plus" size={16} color={theme.accent?.val} />}
              />
            </Pressable>
          </YStack>
          <Pressable label={again ? `Offer ${entry.name} again` : `Not mine: ${entry.name}`} onPress={() => void ignore(entry, again)}>
            <YStack width={44} height={44} alignItems="center" justifyContent="center">
              <Icon name={again ? 'rotate-ccw' : 'x'} size={16} color={theme.muted?.val} />
            </YStack>
          </Pressable>
        </XStack>
      </YStack>
    );
  };

  // Many behind one account or gateway — a family's Find My — are one row, opening its page, where they are chosen from.
  const behind = new Map<string, { through: NonNullable<FoundView['through']>; count: number }>();
  for (const entry of found) if (entry.through) behind.set(entry.through.id, { through: entry.through, count: (behind.get(entry.through.id)?.count ?? 0) + 1 });
  const grouped = [...behind.values()].filter((group) => group.count >= GROUP_FROM);
  const single = found.filter((entry) => !entry.through || (behind.get(entry.through.id)?.count ?? 0) < GROUP_FROM);
  const group = ({ through, count }: { through: NonNullable<FoundView['through']>; count: number }, index: number) => (
    <YStack key={`group-${through.id}`}>
      {index > 0 ? <RowSeparator /> : null}
      <Pressable onPress={() => router.push(PATHS.devices.one(through.id))}>
        <Row
          leading={
            <YStack width={36} height={36} alignItems="center" justifyContent="center">
              <Icon name="layers" size={20} color={theme.muted?.val} />
            </YStack>
          }
          title={`${count} devices through ${through.name}`}
          subtitle="Not added yet · choose which to add"
          accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
        />
      </Pressable>
    </YStack>
  );

  return (
    <YStack gap="$2">
      <SectionLabel>Found near you</SectionLabel>
      <Card inset>
        {single.map((entry, index) => row(entry, index, false))}
        {grouped.map((each, index) => group(each, single.length + index))}
        {ignored.length ? (
          <YStack>
            {found.length ? <RowSeparator /> : null}
            <Pressable onPress={() => setShowIgnored((shown) => !shown)}>
              <Row
                title={`${ignored.length} you said ${ignored.length === 1 ? 'is' : 'are'} not yours`}
                subtitle={showIgnored ? 'Offer one again, or add it' : 'Show them'}
                accessory={<Icon name={showIgnored ? 'chevron-up' : 'chevron-down'} size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </YStack>
        ) : null}
        {showIgnored ? ignored.map((entry, index) => row(entry, index + 1, true)) : null}
      </Card>
    </YStack>
  );
}
