import { useState, type ReactNode } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type HomeView, type VariableView } from '@kraftverk/api-client';
import { VARIABLE_KIND_WORDS, VARIABLE_KINDS, variableFieldOf, variableKeyFrom, variableProblems, variableTypedOf, type VariableKind, type VariableSpec } from '@kraftverk/automation';
import { isUnit, type ConfigField } from '@kraftverk/device-sdk';
import { Card, Chips, haptic, Icon, parseNumberText, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useTone } from '../../components/tone';
import { useAnswer } from '../../components/useAnswer';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';
import { useHomeVariables } from '../home/VariablesCard';

/*
  Variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md): each home's own typed
  state — guests staying, the dryer's runs, when to wake — that its
  automations read and set by key, and its people change on the home
  screen. Declared here: a title, a kind, and by its kind a unit and range,
  or options; changed here too — its title, its range, its options — its
  key and kind kept, so what automations say of it stays true.
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

/** A home's variables: each with its kind and key, opened to change it — and one more. */
function HomeVariables({ home, titled }: { home: HomeView; titled: boolean }) {
  const { api } = useFamily();
  const tone = useTone();
  const { variables, reload } = useHomeVariables(home.id);
  const [open, setOpen] = useState<string | null>(null);
  const taken = (key: string) => (variables ?? []).some((variable) => variable.key === key);
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
              {open === variable.id ? (
                <YStack padding="$4">
                  <VariableForm
                    variable={variable}
                    taken={taken}
                    onSave={async (input) => {
                      await api.variables.update(variable.id, { field: input.field, ...(input.length !== undefined ? { length: input.length } : {}) });
                      setOpen(null);
                      await reload();
                    }}
                    onCancel={() => setOpen(null)}
                    onRemove={async () => {
                      if (!(await confirmAction(`Let ${variable.field.title} go?`, 'An automation that reads or sets it can no longer.', 'Let it go', 'dangerous'))) return;
                      await api.variables.remove(variable.id);
                      setOpen(null);
                      await reload();
                    }}
                  />
                </YStack>
              ) : (
                <Pressable label={`Change ${variable.field.title}`} onPress={() => setOpen(variable.id)}>
                  <Row title={variable.field.title} subtitle={`${VARIABLE_KIND_WORDS[variable.kind].label} · home.var.${variable.key}`} accessory={<Icon name="chevron-right" size={16} color={tone('$muted')} />} />
                </Pressable>
              )}
            </YStack>
          ))
        ) : (
          <Row title="None yet" subtitle="Guests staying, a target temperature, how many times the dryer ran" />
        )}
      </Card>
      <Card>
        <VariableForm
          key={variables?.length ?? 0}
          taken={taken}
          onSave={async (input) => {
            await api.variables.add(home.id, input);
            await reload();
          }}
        />
      </Card>
    </YStack>
  );
}

/** A field of the form, its words above it: seen once it is filled, as a placeholder is not. */
function Labelled({ label, grow, children }: { label: string; grow?: boolean; children: ReactNode }) {
  return (
    <YStack gap="$1" {...(grow ? { flex: 1, minWidth: 120 } : {})}>
      <Text fontSize={13} fontWeight="600" color="$muted">
        {label}
      </Text>
      {children}
    </YStack>
  );
}

/**
 * A variable as a person says it: its title, its kind — chosen once — and
 * by its kind a unit and range, or options. New, it makes its key from its
 * title; changed, it keeps its key and kind, and an option's value.
 */
function VariableForm({
  variable,
  taken,
  onSave,
  onCancel,
  onRemove,
}: {
  variable?: VariableView;
  taken: (key: string) => boolean;
  onSave: (input: VariableSpec) => Promise<void>;
  onCancel?: () => void;
  onRemove?: () => Promise<void>;
}) {
  const typed = variable ? variableTypedOf({ ...variable, ...(variable.length !== null ? { length: variable.length } : { length: undefined }) }) : null;
  const [title, setTitle] = useState(typed?.title ?? '');
  const [kind, setKind] = useState<VariableKind>(typed?.kind ?? 'toggle');
  const [unit, setUnit] = useState(typed?.unit ?? '');
  const [min, setMin] = useState(typed?.min !== undefined && typed.min !== null ? String(typed.min) : '');
  const [max, setMax] = useState(typed?.max !== undefined && typed.max !== null ? String(typed.max) : '');
  const [options, setOptions] = useState(typed?.options?.join(', ') ?? '');
  // A timer's length, in minutes: what a person says it in.
  const [minutes, setMinutes] = useState(typed?.length ? String(Math.round((typed.length / 60) * 100) / 100) : '45');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // What was typed, as a variable — and what is wrong with it, before it is sent.
  const typedUnit = unit.trim();
  const number = (text: string, what: string): { value: number | null; problem: string | null } => {
    if (!text.trim()) return { value: null, problem: null };
    const value = parseNumberText(text);
    return value === null ? { value: null, problem: `${what} is a number: "${text.trim()}" is not one` } : { value, problem: null };
  };
  const [least, most, runs] = [number(min, 'At least'), number(max, 'At most'), number(minutes, 'How long')];
  const length = kind === 'timer' && runs.value !== null ? Math.round(runs.value * 60) : undefined;
  const field: ConfigField = variableFieldOf(
    { title, kind, unit: typedUnit && isUnit(typedUnit) ? typedUnit : null, min: least.value, max: most.value, options: options.split(',') },
    variable?.field
  );
  const key = variable?.key ?? variableKeyFrom(title, taken);
  const problems = title.trim()
    ? [...(typedUnit && !isUnit(typedUnit) ? [`"${typedUnit}" is not a unit kraftverk knows: °C, kWh, %, W`] : []), ...[least.problem, most.problem, runs.problem].filter((each): each is string => each !== null), ...variableProblems({ key, kind, field, ...(length !== undefined ? { length } : {}) })]
    : [];
  const ranged = kind === 'number' || kind === 'counter';
  const changed = !variable || JSON.stringify(field) !== JSON.stringify(variable.field) || (kind === 'timer' && length !== (variable.length ?? undefined));

  const doing = async (work: () => Promise<void>, failed: string) => {
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
    <YStack gap="$3">
      <Labelled label="Title">
        <Input aria-label="A variable's title" placeholder="Guests staying" size="$4" maxLength={60} value={title} onChangeText={setTitle} />
      </Labelled>
      {variable ? (
        <Text fontSize={13} color="$muted">
          {VARIABLE_KIND_WORDS[kind].label} · in automations: home.var.{key}
        </Text>
      ) : (
        <>
          <Chips label="What it holds" options={KINDS} value={kind} onChange={setKind} />
          <Text fontSize={12} color="$muted" lineHeight={17}>
            {VARIABLE_KIND_WORDS[kind].says}
          </Text>
        </>
      )}
      {kind === 'number' ? (
        <Labelled label="Unit, if it has one">
          <Input aria-label="Its unit" placeholder="°C" size="$4" maxLength={12} value={unit} onChangeText={setUnit} />
        </Labelled>
      ) : null}
      {ranged ? (
        <XStack gap="$2" flexWrap="wrap">
          <Labelled label="At least" grow>
            <Input aria-label="At least" placeholder={kind === 'counter' ? '0' : 'Any'} inputMode="decimal" size="$4" value={min} onChangeText={setMin} />
          </Labelled>
          <Labelled label="At most" grow>
            <Input aria-label="At most" placeholder="Any" inputMode="decimal" size="$4" value={max} onChangeText={setMax} />
          </Labelled>
        </XStack>
      ) : null}
      {kind === 'timer' ? (
        <Labelled label="Runs for, in minutes">
          <Input aria-label="How long it runs" placeholder="45" inputMode="decimal" size="$4" value={minutes} onChangeText={setMinutes} />
        </Labelled>
      ) : null}
      {kind === 'choice' ? (
        <Labelled label="Options, by commas">
          <Input aria-label="Its options" placeholder="Washing, Drying, Done" size="$4" value={options} onChangeText={setOptions} />
        </Labelled>
      ) : null}
      {!variable && title.trim() ? (
        <Text fontSize={12} color="$muted">
          In automations: home.var.{key}
        </Text>
      ) : null}
      {problem || problems[0] ? <ErrorText>{problem ?? problems[0]}</ErrorText> : null}
      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        <Button
          flex={variable ? undefined : 1}
          size="$3"
          minHeight={44}
          backgroundColor="$accent"
          color="$background"
          disabled={!title.trim() || problems.length > 0 || busy || !changed}
          opacity={!title.trim() || problems.length > 0 || busy || !changed ? 0.5 : 1}
          onPress={() =>
            void doing(async () => {
              await onSave({ key, kind, field, ...(length !== undefined ? { length } : {}) });
              if (variable) return;
              setTitle('');
              setUnit('');
              setMin('');
              setMax('');
              setOptions('');
              setMinutes('45');
            }, variable ? 'It could not be changed' : 'The variable could not be added')
          }
        >
          {variable ? 'Save' : 'Add a variable'}
        </Button>
        {onCancel ? (
          <Button size="$3" minHeight={44} chromeless disabled={busy} onPress={onCancel}>
            Cancel
          </Button>
        ) : null}
        {onRemove ? (
          <Button size="$3" minHeight={44} chromeless color="$danger" marginLeft="auto" disabled={busy} onPress={() => void doing(onRemove, 'It could not be let go')}>
            Let it go
          </Button>
        ) : null}
      </XStack>
    </YStack>
  );
}
