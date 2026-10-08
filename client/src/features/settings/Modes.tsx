import { useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type HomeView, type ModeAxis } from '@kraftverk/api-client';
import { Card, Chips, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';
import { modeLine, useHomeModes } from '../home/ModesCard';

/*
  Modes (docs/PLAN-WORLD-MODEL.md §8.10): the built-in ones every family has,
  and its own on either axis — "guests over", "movie night" — what an
  automation sets and reads by its key. And a mode planned ahead for a home:
  a vacation from one day to another, the mode before coming back after.
*/

const AXES: readonly { value: ModeAxis; label: string }[] = [
  { value: 'presence', label: 'Whether anyone is home' },
  { value: 'day', label: 'The time of day' },
];

/** "2026-10-12 08:00", or "2026-10-12" for its midnight, on this device's clock; null when it is not one. */
const typedTime = (typed: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(typed.trim());
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00'] = match;
  const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

export function Modes() {
  const { api } = useFamily();
  const homes = useAnswer(() => api.homes.list(), [api]).value ?? null;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [axis, setAxis] = useState<ModeAxis>('presence');
  const listed = useAnswer(() => api.modes.list(), [api, busy]);
  const own = (listed.value ?? []).filter((mode) => !mode.builtIn);

  const doing = async (work: () => Promise<unknown>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Modes" subtitle="Whether anyone is home, and the time of day: what automations set and follow">
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {homes ? homes.map((home) => <PlanAhead key={home.id} home={home} />) : <Spinner color="$accent" />}

      <YStack gap="$2">
        <SectionLabel>Your own</SectionLabel>
        <Card inset>
          {own.length ? (
            own.map((mode, index) => (
              <YStack key={mode.id}>
                {index ? <RowSeparator /> : null}
                <Row
                  title={mode.name}
                  subtitle={`${mode.axis === 'presence' ? 'Whether anyone is home' : 'The time of day'} · in automations: ${mode.key}`}
                  accessory={
                    <Button
                      size="$2"
                      chromeless
                      color="$muted"
                      disabled={busy}
                      onPress={() => void confirmAction(`Let ${mode.name} go? An automation that sets it can no longer.`, 'Let it go').then((yes) => (yes ? doing(() => api.modes.remove(mode.id), 'It could not be let go') : undefined))}
                    >
                      Let go
                    </Button>
                  }
                />
              </YStack>
            ))
          ) : (
            <Row title="None yet" subtitle="Home, away, vacation; day, evening, night — every family has these" />
          )}
        </Card>
        <Card gap="$3">
          <Input aria-label="A mode of your own" placeholder="Its name: Guests over" size="$4" maxLength={30} value={name} onChangeText={setName} />
          <Chips label="Which axis" options={AXES} value={axis} onChange={setAxis} />
          <Button
            size="$3"
            minHeight={44}
            backgroundColor="$accent"
            color="$background"
            disabled={!name.trim() || busy}
            onPress={() =>
              void doing(async () => {
                await api.modes.add({ axis, name: name.trim() });
                setName('');
              }, 'The mode could not be added')
            }
          >
            Add a mode
          </Button>
        </Card>
      </YStack>
    </Screen>
  );
}

/** A home's modes now, and one planned ahead: from a time, until another. */
function PlanAhead({ home }: { home: HomeView }) {
  const { api } = useFamily();
  const { modes, all, reload } = useHomeModes(home.id);
  const [mode, setMode] = useState<string | null>('vacation');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromAt = typedTime(from);
  const untilAt = until.trim() ? typedTime(until) : null;
  const ready = mode && fromAt && (until.trim() === '' || untilAt);
  return (
    <YStack gap="$2">
      <SectionLabel>{home.name}</SectionLabel>
      <Card gap="$3">
        {modes ? (
          modes.map((each) => (
            <Text key={each.axis} fontSize={13} color="$color">
              {each.axis === 'presence' ? 'Anyone home: ' : 'The time of day: '}
              {modeLine(each)}
            </Text>
          ))
        ) : (
          <Spinner color="$accent" />
        )}
        <Text fontSize={13} color="$muted" lineHeight={18}>
          Plan one ahead — away from Saturday morning to Sunday week — and what was before comes back after it.
        </Text>
        <Chips label={`Plan a mode for ${home.name}`} options={all.map((each) => ({ value: each.id, label: each.name }))} value={mode} onChange={setMode} />
        <XStack gap="$2" flexWrap="wrap">
          <Input flex={1} minWidth={160} aria-label="From" placeholder="From: 2026-10-12 08:00" size="$4" value={from} onChangeText={setFrom} />
          <Input flex={1} minWidth={160} aria-label="Until" placeholder="Until (none: for good)" size="$4" value={until} onChangeText={setUntil} />
        </XStack>
        {problem ? <ErrorText>{problem}</ErrorText> : null}
        <Button
          size="$3"
          minHeight={44}
          backgroundColor="$accent"
          color="$background"
          disabled={!ready || busy}
          onPress={() => {
            haptic();
            setBusy(true);
            setProblem(null);
            void api.modes
              .set(home.id, { mode: mode!, from: fromAt!, until: untilAt })
              .then(() => (setFrom(''), setUntil(''), reload()))
              .catch((err: unknown) => setProblem(describeError(err) || 'It could not be planned'))
              .finally(() => setBusy(false));
          }}
        >
          Plan it
        </Button>
      </Card>
    </YStack>
  );
}
