import { useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { depthOf, describeError, INSIDE, isWithin, openingLine, SPACE_KIND_LABELS, SPACE_PURPOSE_LABELS, spaceLine, type HomeView, type OpeningKind, type SpaceKind, type SpacePurpose, type SpaceView } from '@kraftverk/api-client';
import { Card, Chips, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';
import { useHomeSpaces } from '../../state/useHomeSpaces';

type Kind = Exclude<SpaceKind, 'site'>;

const PURPOSES = Object.entries(SPACE_PURPOSE_LABELS).map(([value, label]) => ({ value: value as SpacePurpose, label }));
const OPENING_KINDS: readonly { value: OpeningKind; label: string }[] = [
  { value: 'door', label: 'Door' },
  { value: 'opening', label: 'Opening' },
  { value: 'stairs', label: 'Stairs' },
  { value: 'window', label: 'Window' },
  { value: 'gate', label: 'Gate' },
  { value: 'garage-door', label: 'Garage door' },
  { value: 'elevator', label: 'Elevator' },
];
const kindsIn = (parent: SpaceView) => INSIDE[parent.kind].map((value) => ({ value, label: SPACE_KIND_LABELS[value] }));
const nameOf = (space: SpaceView) => (space.kind === 'site' ? 'The home itself' : space.name);

/**
 * A home's buildings, floors and rooms (docs/PLAN-WORLD-MODEL.md §8.5), and
 * the doors and stairs between them: added, renamed, moved, and removed —
 * what stood in one moves out to the space it was in, and what was read
 * there stays its history.
 */
export function SpacesEditor({ home }: { home: HomeView }) {
  const { api } = useFamily();
  const { homes, reload } = useHomeSpaces();
  const here = homes?.find((each) => each.home.id === home.id);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doing = async (work: () => Promise<unknown>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await reload();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };

  if (!here) return <Spinner color="$accent" />;
  const spaces = here.spaces;
  const site = spaces.find((space) => space.kind === 'site')!;
  const inner = spaces.filter((space) => space.kind !== 'site');

  return (
    <YStack gap="$4">
      <YStack gap="$2">
        <SectionLabel>Buildings, floors and rooms</SectionLabel>
        <Card inset>
          {inner.length === 0 ? (
            <Text fontSize={13} color="$muted" lineHeight={19} padding="$4">
              None yet. Add the rooms your devices stand in — a building and its floors too, where there is more than one.
            </Text>
          ) : null}
          {inner.map((space, index) => (
            <YStack key={space.id}>
              {index ? <RowSeparator /> : null}
              <Row
                leading={depthOf(space, spaces) ? <YStack width={depthOf(space, spaces) * 16} /> : undefined}
                title={space.name}
                subtitle={space.purpose ? SPACE_PURPOSE_LABELS[space.purpose] : SPACE_KIND_LABELS[space.kind as Kind]}
                accessory={
                  <Button size="$3" minHeight={44} chromeless onPress={() => setOpen(open === space.id ? null : space.id)} aria-expanded={open === space.id}>
                    {open === space.id ? 'Done' : 'Change'}
                  </Button>
                }
              />
              {open === space.id ? <SpaceChanges space={space} spaces={spaces} busy={busy} doing={doing} /> : null}
            </YStack>
          ))}
        </Card>
        <AddSpace site={site} spaces={spaces} busy={busy} doing={doing} />
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Doors and stairs</SectionLabel>
        <Card inset>
          {here.openings.length === 0 ? (
            <Text fontSize={13} color="$muted" lineHeight={19} padding="$4">
              Where rooms meet, or meet the outside: a door sensor stands at one.
            </Text>
          ) : null}
          {here.openings.map((opening, index) => (
            <YStack key={opening.id}>
              {index ? <RowSeparator /> : null}
              <Row
                title={openingLine(opening, spaces)}
                accessory={
                  <Button size="$3" minHeight={44} chromeless color="$danger" disabled={busy} onPress={() => void doing(() => api.openings.remove(opening.id), 'It could not be removed')}>
                    Remove
                  </Button>
                }
              />
            </YStack>
          ))}
        </Card>
        {inner.length ? <AddOpening spaces={inner} busy={busy} doing={doing} /> : null}
      </YStack>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
    </YStack>
  );
}

type Doing = (work: () => Promise<unknown>, failed: string) => Promise<void>;

/** One space opened: its name, what it is for, where it is, and removing it. */
function SpaceChanges({ space, spaces, busy, doing }: { space: SpaceView; spaces: readonly SpaceView[]; busy: boolean; doing: Doing }) {
  const { api } = useFamily();
  const [name, setName] = useState(space.name);
  // Where it may move: a space that may hold its kind, not itself nor inside it.
  const parents = spaces.filter((each) => INSIDE[each.kind].includes(space.kind as Kind) && !isWithin(each, space, spaces));
  const remove = async () => {
    if (!(await confirmAction(`Remove ${space.name}?`, 'What is inside it goes too, and what stands there moves out to the space it is in. What was read there is kept.', 'Remove', 'careful'))) return;
    await doing(() => api.spaces.remove(space.id), 'It could not be removed');
  };
  return (
    <YStack gap="$3" paddingHorizontal="$4" paddingBottom="$4">
      <XStack gap="$2" alignItems="center">
        <Input flex={1} aria-label="Its name" size="$4" maxLength={60} value={name} onChangeText={setName} />
        {name.trim() && name.trim() !== space.name ? (
          <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy} onPress={() => void doing(() => api.spaces.update(space.id, { name: name.trim() }), 'That name could not be saved')}>
            Save
          </Button>
        ) : null}
      </XStack>
      {space.kind === 'room' ? <Chips label="What it is for" options={PURPOSES} value={space.purpose} onChange={(purpose) => void doing(() => api.spaces.update(space.id, { purpose }), 'That could not be changed')} /> : null}
      {parents.length > 1 ? (
        <YStack gap="$2">
          <Text fontSize={12} color="$muted">
            Where it is
          </Text>
          <Chips label="Where it is" options={parents.map((each) => ({ value: each.id, label: nameOf(each) }))} value={space.parentId} onChange={(parentId) => void doing(() => api.spaces.update(space.id, { parentId }), 'It could not be moved')} />
        </YStack>
      ) : null}
      <XStack>
        <Button size="$3" minHeight={44} chromeless color="$danger" disabled={busy} onPress={() => void remove()}>
          Remove {space.name}
        </Button>
      </XStack>
    </YStack>
  );
}

/** A space added: in the home itself or inside another, of a kind that may be there. */
function AddSpace({ site, spaces, busy, doing }: { site: SpaceView; spaces: readonly SpaceView[]; busy: boolean; doing: Doing }) {
  const { api } = useFamily();
  const holders = spaces.filter((space) => INSIDE[space.kind].length);
  const [parentId, setParentId] = useState(site.id);
  const parent = spaces.find((space) => space.id === parentId) ?? site;
  const [kind, setKind] = useState<Kind>('room');
  const [purpose, setPurpose] = useState<SpacePurpose | null>(null);
  const [name, setName] = useState('');
  const kinds = kindsIn(parent);
  const chosen = kinds.some((each) => each.value === kind) ? kind : kinds[0]!.value;
  const add = () =>
    doing(async () => {
      await api.spaces.add({ parentId: parent.id, kind: chosen, name: name.trim(), ...(chosen === 'room' && purpose ? { purpose } : {}) });
      setName('');
      setPurpose(null);
    }, 'It could not be added');
  return (
    <Card gap="$3">
      <Text fontSize={15} fontWeight="600" color="$color">
        Add a space
      </Text>
      {holders.length > 1 ? (
        <YStack gap="$2">
          <Text fontSize={12} color="$muted">
            Where it is
          </Text>
          <Chips label="Where it is" options={holders.map((each) => ({ value: each.id, label: each.kind === 'site' ? 'The home itself' : spaceLine(each, spaces) === each.name ? each.name : each.name }))} value={parent.id} onChange={setParentId} />
        </YStack>
      ) : null}
      <Chips label="What it is" options={kinds} value={chosen} onChange={setKind} />
      {chosen === 'room' ? <Chips label="What it is for" options={PURPOSES} value={purpose} onChange={(value) => (setPurpose(value), !name.trim() && setName(SPACE_PURPOSE_LABELS[value]))} /> : null}
      <XStack gap="$2" alignItems="center">
        <Input flex={1} aria-label="Its name" placeholder={chosen === 'floor' ? 'Ground floor' : chosen === 'building' ? 'House' : 'Kitchen'} size="$4" maxLength={60} value={name} onChangeText={setName} />
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={!name.trim() || busy} opacity={!name.trim() || busy ? 0.5 : 1} onPress={() => void add()}>
          Add
        </Button>
      </XStack>
    </Card>
  );
}

/** An opening added: from one space, to another or to the outside. */
function AddOpening({ spaces, busy, doing }: { spaces: readonly SpaceView[]; busy: boolean; doing: Doing }) {
  const { api } = useFamily();
  const [kind, setKind] = useState<OpeningKind>('door');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string>('outside');
  const [name, setName] = useState('');
  // A door is between rooms, or floors for stairs: a building's own door is its hall's.
  const rooms = spaces.filter((space) => space.kind !== 'building').map((space) => ({ value: space.id, label: space.name }));
  const add = () =>
    doing(async () => {
      await api.openings.add({ kind, fromId: from!, toId: to === 'outside' ? null : to, ...(name.trim() ? { name: name.trim() } : {}) });
      setName('');
    }, 'It could not be added');
  return (
    <Card gap="$3">
      <Text fontSize={15} fontWeight="600" color="$color">
        Add a door, stairs, a window
      </Text>
      <Chips label="What it is" options={OPENING_KINDS} value={kind} onChange={setKind} />
      <Text fontSize={12} color="$muted">
        From
      </Text>
      <Chips label="From" options={rooms} value={from} onChange={setFrom} />
      <Text fontSize={12} color="$muted">
        To
      </Text>
      <Chips label="To" options={[{ value: 'outside', label: 'The outside' }, ...rooms.filter((room) => room.value !== from)]} value={to} onChange={setTo} />
      <XStack gap="$2" alignItems="center">
        <Input flex={1} aria-label="Its name" placeholder="Front door" size="$4" maxLength={60} value={name} onChangeText={setName} />
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={!from || busy} opacity={!from || busy ? 0.5 : 1} onPress={() => void add()}>
          Add
        </Button>
      </XStack>
    </Card>
  );
}
