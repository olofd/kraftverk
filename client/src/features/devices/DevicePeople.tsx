import { useEffect, useState } from 'react';
import { Text, YStack } from 'tamagui';

import { describeError, type DevicePeople as People, type DeviceView, type PersonView } from '@kraftverk/api-client';
import { Chips, RowSeparator, ToggleChips } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';

/** Nobody, as a chip's value: no person's id is empty. */
const NOBODY = '';

/**
 * Who a device is with (docs/PLAN-WORLD-MODEL.md §8.8), in its settings: who
 * carries one that says where it is — where it is, they are — and whose any
 * device is. Each a person in the family.
 */
export function DevicePeople({ device, located }: { device: DeviceView; located: boolean }) {
  const { api } = useFamily();
  const { setPeople } = useDevices();
  const [members, setMembers] = useState<PersonView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void api.people
      .list()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [api]);

  // A family of one, or none yet: nobody else to choose.
  if (!members?.length || device.removedAt) return null;
  const change = (people: Partial<People>) => {
    setProblem(null);
    setPeople(device.id, people).catch((err: unknown) => setProblem(describeError(err) || 'That could not be changed'));
  };
  const options = members.map((person) => ({ value: person.id, label: person.shownAs, color: person.member?.color ?? null }));

  return (
    <>
      {located ? (
        <>
          <RowSeparator />
          <YStack gap="$2" paddingHorizontal="$4" paddingVertical="$3">
            <Text fontSize={14} fontWeight="600" color="$color">
              Who carries it
            </Text>
            <Text fontSize={12} color="$muted" lineHeight={17}>
              Where it is, they are: what the family is shown of them, at what they share.
            </Text>
            <Chips label="Who carries it" options={[{ value: NOBODY, label: 'Nobody' }, ...options]} value={device.people.carries ?? NOBODY} onChange={(id) => change({ carries: id === NOBODY ? null : id })} />
          </YStack>
        </>
      ) : null}
      <RowSeparator />
      <YStack gap="$2" paddingHorizontal="$4" paddingVertical="$3">
        <Text fontSize={14} fontWeight="600" color="$color">
          Whose it is
        </Text>
        <ToggleChips label="Whose it is" options={options} value={device.people.owns} onChange={(owns) => change({ owns })} />
      </YStack>
      {problem ? <ErrorText paddingHorizontal="$4">{problem}</ErrorText> : null}
    </>
  );
}
