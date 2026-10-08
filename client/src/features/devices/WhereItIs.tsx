import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { depthOf, describeError, openingLine, placeLine, type DeviceView, type PlacementInput } from '@kraftverk/api-client';
import { Card, Chips, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { useFamily } from '../../state/FamilyProvider';
import { useHomeSpaces } from '../../state/useHomeSpaces';

/**
 * Where a device stands (docs/PLAN-WORLD-MODEL.md §8.6): a room of a home —
 * the home itself when no room is said — perhaps at a door it watches. One
 * that moves, a car, is based there instead. Moved, what it read before stays
 * the room's it was in.
 */
export function WhereItIs({ device }: { device: DeviceView }) {
  const { api } = useFamily();
  const { homes } = useHomeSpaces();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const placement = device.placement;
  const [homeId, setHomeId] = useState<string | null>(placement?.homeId ?? null);
  // A device that says where it is goes about: it is based somewhere, not standing there.
  const moves = device.description.attributes.some((attribute) => attribute.means === 'position');

  if (!homes) return null;
  const home = homes.find((each) => each.home.id === (homeId ?? placement?.homeId)) ?? homes[0];
  if (!home) return null;

  const place = async (input: PlacementInput | null) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await api.devices.place(device.id, input);
    } catch (err) {
      setProblem(describeError(err) || 'That could not be saved');
    } finally {
      setBusy(false);
    }
  };
  const role = placement?.role ?? (moves ? 'based' : 'stands');
  const standing = placement && placement.homeId === home.home.id ? home.spaces.find((space) => space.id === placement.spaceId) : undefined;
  const doors = standing ? home.openings.filter((opening) => opening.fromId === standing.id || opening.toId === standing.id) : [];

  return (
    <YStack gap="$2">
      <SectionLabel>Where it is</SectionLabel>
      <Card inset>
        <Row
          title={placement ? placeLine(placement, homes) : 'Not said yet'}
          subtitle={placement ? (placement.role === 'based' ? 'Where it comes back to' : 'What it reads is that room’s') : 'Say which room it is in: your home screen groups devices by room'}
          accessory={
            <Button size="$3" minHeight={44} chromeless onPress={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Done' : placement ? 'Change' : 'Say where'}
            </Button>
          }
        />
        {open ? (
          <YStack gap="$3" paddingHorizontal="$4" paddingBottom="$4">
            {homes.length > 1 ? <Chips label="Which home" options={homes.map((each) => ({ value: each.home.id, label: each.home.name }))} value={home.home.id} onChange={setHomeId} /> : null}
            <YStack borderRadius={12} borderWidth={1} borderColor="$borderColor" overflow="hidden">
              {home.spaces.map((space, index) => {
                const chosen = standing?.id === space.id;
                return (
                  <YStack key={space.id}>
                    {index ? <RowSeparator /> : null}
                    <Pressable selected={chosen} disabled={busy} onPress={() => void place({ spaceId: space.id, role })}>
                      <XStack minHeight={44} alignItems="center" paddingVertical="$2" paddingRight="$3" paddingLeft={12 + (space.kind === 'site' ? 0 : (depthOf(space, home.spaces) + 1) * 16)}>
                        <Text flex={1} fontSize={15} fontWeight={chosen ? '700' : '400'} color="$color">
                          {space.kind === 'site' ? `${home.home.name}, no room said` : space.name}
                        </Text>
                      </XStack>
                    </Pressable>
                  </YStack>
                );
              })}
            </YStack>
            {standing && doors.length ? (
              <YStack gap="$2">
                <Text fontSize={12} color="$muted">
                  At a door or a window — one it watches
                </Text>
                <Chips
                  label="At an opening"
                  options={[{ value: 'none', label: 'None' }, ...doors.map((opening) => ({ value: opening.id, label: openingLine(opening, home.spaces, standing.id) }))]}
                  value={placement?.openingId ?? 'none'}
                  onChange={(value) => void place({ spaceId: standing.id, openingId: value === 'none' ? null : value, role })}
                />
              </YStack>
            ) : null}
            {placement ? (
              <Chips
                label="Stands or is based"
                options={[
                  { value: 'stands', label: 'It stands there' },
                  { value: 'based', label: 'It is based there' },
                ]}
                value={placement.role}
                onChange={(value) => void place({ spaceId: placement.spaceId, openingId: placement.openingId, role: value })}
              />
            ) : null}
            {placement ? (
              <XStack>
                <Button size="$3" minHeight={44} chromeless color="$muted" disabled={busy} onPress={() => void place(null)}>
                  Not in any room
                </Button>
              </XStack>
            ) : null}
          </YStack>
        ) : null}
      </Card>
      {problem ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {problem}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
