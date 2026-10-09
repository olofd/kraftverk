import { useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type HomeView } from '@kraftverk/api-client';
import { VARIABLE_KIND_WORDS, VARIABLE_KINDS, variableFieldOf, variableKeyFrom, variableProblems, type VariableKind } from '@kraftverk/automation';
import { isUnit } from '@kraftverk/device-sdk';
import { Card, Chips, haptic, parseNumberText, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';
import { useHomeVariables } from '../home/VariablesCard';

/*
  Variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md): each home's own typed
  state — guests staying, the dryer's runs, when to wake — that its
  automations read and set by key, and its people change on the home
  screen. Declared here: a title, a kind, and by its kind a unit and range,
  or options. Changed further in the configuration file.
*/

const KINDS: readonly { value: VariableKind; label: string }[] = VARIABLE_KINDS.map((value) => ({ value, label: VARIABLE_KIND_WORDS[value].label }));

export function Variables() {
  const { api } = useFamily();
  const read = useAnswer(() => api.homes.list(), [api]);
  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Variables" subtitle="Each home’s own values — guests staying, the dryer’s runs, when to wake — that automations read and set">
      {read.value ? read.value.map((home) => <HomeVariables key={home.id} home={home} titled={read.value!.length > 1} />) : read.error ? <ErrorText paddingHorizontal="$1">{read.error}</ErrorText> : <Spinner color="$accent" />}
    </Screen>
  );
}

/** A home's variables: each with its key, what it holds, and a way to let it go — and one more. */
function HomeVariables({ home, titled }: { home: HomeView; titled: boolean }) {
  const { api } = useFamily();
  const { variables, reload } = useHomeVariables(home.id);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<VariableKind>('toggle');
  const [unit, setUnit] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [options, setOptions] = useState('');

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

  // What was typed, as a variable — and what is wrong with it, before it is sent.
  const typedUnit = unit.trim();
  const field = variableFieldOf({
    title,
    kind,
    unit: typedUnit && isUnit(typedUnit) ? typedUnit : null,
    min: parseNumberText(min),
    max: parseNumberText(max),
    options: options.split(','),
  });
  const key = variableKeyFrom(title, (taken) => (variables ?? []).some((variable) => variable.key === taken));
  const problems = title.trim() ? [...(typedUnit && !isUnit(typedUnit) ? [`"${typedUnit}" is not a unit kraftverk knows: °C, kWh, %, W`] : []), ...variableProblems({ key, kind, field })] : [];
  const ranged = kind === 'number' || kind === 'counter';

  return (
    <YStack gap="$2">
      <SectionLabel>{titled ? home.name : 'Your variables'}</SectionLabel>
      <Card inset>
        {variables === null ? (
          <Row title="Reading…" />
        ) : variables.length ? (
          variables.map((variable, index) => (
            <YStack key={variable.id}>
              {index ? <RowSeparator /> : null}
              <Row
                title={variable.field.title}
                subtitle={`${VARIABLE_KIND_WORDS[variable.kind].label} · home.var.${variable.key}`}
                accessory={
                  <Button
                    size="$2"
                    chromeless
                    color="$muted"
                    disabled={busy}
                    onPress={() => void confirmAction(`Let ${variable.field.title} go?`, 'An automation that reads or sets it can no longer.', 'Let it go', 'dangerous').then((yes) => (yes ? doing(() => api.variables.remove(variable.id), 'It could not be let go') : undefined))}
                  >
                    Let go
                  </Button>
                }
              />
            </YStack>
          ))
        ) : (
          <Row title="None yet" subtitle="Guests staying, a target temperature, how many times the dryer ran" />
        )}
      </Card>
      <Card gap="$3">
        <Input aria-label="A variable's title" placeholder="Its title: Guests staying" size="$4" maxLength={60} value={title} onChangeText={setTitle} />
        <Chips label="What it holds" options={KINDS} value={kind} onChange={setKind} />
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {VARIABLE_KIND_WORDS[kind].says}
        </Text>
        {kind === 'number' ? <Input aria-label="Its unit" placeholder="Its unit, if it has one: °C" size="$4" maxLength={12} value={unit} onChangeText={setUnit} /> : null}
        {ranged ? (
          <XStack gap="$2" flexWrap="wrap">
            <Input flex={1} minWidth={120} aria-label="At least" placeholder={kind === 'counter' ? 'At least: 0' : 'At least (any)'} inputMode="decimal" size="$4" value={min} onChangeText={setMin} />
            <Input flex={1} minWidth={120} aria-label="At most" placeholder="At most (any)" inputMode="decimal" size="$4" value={max} onChangeText={setMax} />
          </XStack>
        ) : null}
        {kind === 'choice' ? <Input aria-label="Its options" placeholder="Its options, by commas: Washing, Drying, Done" size="$4" value={options} onChangeText={setOptions} /> : null}
        {title.trim() ? (
          <Text fontSize={12} color="$muted">
            In automations: home.var.{key}
          </Text>
        ) : null}
        {problem || problems[0] ? <ErrorText>{problem ?? problems[0]}</ErrorText> : null}
        <Button
          size="$3"
          minHeight={44}
          backgroundColor="$accent"
          color="$background"
          disabled={!title.trim() || problems.length > 0 || busy}
          onPress={() =>
            void doing(async () => {
              await api.variables.add(home.id, { key, kind, field });
              setTitle('');
              setUnit('');
              setMin('');
              setMax('');
              setOptions('');
            }, 'The variable could not be added')
          }
        >
          Add a variable
        </Button>
      </Card>
    </YStack>
  );
}
