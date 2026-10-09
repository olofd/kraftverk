import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { countdownText, describeError, timerLeft, variableLine, type HomeView, type TimerAction, type VariableView } from '@kraftverk/api-client';
import type { Value } from '@kraftverk/device-sdk';
import { Card, Chips, haptic, Icon, SectionLabel, Toggle, type IconName } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useTone } from '../../components/tone';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';
import { NumberField, TimeField } from '../automations/editor/fields';

/*
  A home's variables on the home screen (docs/PLAN-VARIABLES-AND-TRIGGERS.md):
  each as its kind is changed — a switch, its options, a counter's minus and
  plus, a number, words or a time typed and saved — said as who set it and
  when. Read again as the home says one changed: an automation, a script,
  someone else.
*/

export function useHomeVariables(homeId: string | null): {
  variables: VariableView[] | null;
  set: (key: string, value: Value) => Promise<void>;
  count: (key: string, count: { by?: number; reset?: boolean }) => Promise<void>;
  timer: (key: string, action: TimerAction) => Promise<void>;
  problem: string | null;
  reload: () => Promise<void>;
} {
  const { api } = useFamily();
  const { onWorld } = useDevices();
  const [variables, setVariables] = useState<VariableView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!homeId) return;
    try {
      setVariables(await api.variables.list(homeId));
      setProblem(null);
    } catch (err) {
      setProblem(describeError(err) || 'The variables could not be read');
    }
  }, [api, homeId]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => onWorld((what, at) => (what === 'variable' && (at === null || at === homeId) ? void reload() : undefined)), [onWorld, reload, homeId]);
  /** One changed: in place, as the home answers it. */
  const changing = useCallback(
    async (work: () => Promise<VariableView>, failed: string) => {
      haptic();
      setProblem(null);
      try {
        const changed = await work();
        setVariables((list) => list?.map((each) => (each.id === changed.id ? changed : each)) ?? list);
      } catch (err) {
        setProblem(describeError(err) || failed);
      }
    },
    []
  );
  const set = useCallback(async (key: string, value: Value) => (homeId ? changing(() => api.variables.set(homeId, key, value), 'It could not be set') : undefined), [api, homeId, changing]);
  const count = useCallback(async (key: string, by: { by?: number; reset?: boolean }) => (homeId ? changing(() => api.variables.count(homeId, key, by), 'It could not be counted') : undefined), [api, homeId, changing]);
  const timer = useCallback(async (key: string, action: TimerAction) => (homeId ? changing(() => api.variables.timer(homeId, key, action), 'The timer could not be changed') : undefined), [api, homeId, changing]);
  return { variables, set, count, timer, problem, reload };
}

/** A home's variables, on the home screen: none, no card. */
export function VariablesCard({ home, titled }: { home: HomeView; titled: boolean }) {
  const { variables, set, count, timer, problem } = useHomeVariables(home.id);
  if (!variables?.length) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{titled ? `${home.name}’s variables` : 'Variables'}</SectionLabel>
      <Card gap="$4">
        {variables.map((variable) => (
          <VariableRow key={variable.id} variable={variable} set={(value) => void set(variable.key, value)} count={(by) => void count(variable.key, by)} timer={(action) => void timer(variable.key, action)} />
        ))}
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </Card>
    </YStack>
  );
}

/** One variable: its title, what it holds, and a way to change it as its kind is changed. */
function VariableRow({ variable, set, count, timer }: { variable: VariableView; set: (value: Value) => void; count: (by: { by?: number; reset?: boolean }) => void; timer: (action: TimerAction) => void }) {
  const tone = useTone();
  const { field, kind, value } = variable;
  // What it holds is in its control: beneath its title, who set it and when, once someone has. Beside a control, it takes the room left; above one, its own height.
  const titled = (beside: boolean) => (
    <YStack gap="$0.5" {...(beside ? { flex: 1 } : {})}>
      <Text fontSize={15} fontWeight="600" color="$color">
        {field.title}
      </Text>
      {variable.setAt ? (
        <Text fontSize={12} color="$muted">
          {variableLine(variable)}
        </Text>
      ) : null}
    </YStack>
  );
  switch (kind) {
    case 'toggle':
      return (
        <XStack alignItems="center" gap="$3">
          {titled(true)}
          <Toggle checked={value === true} label={field.title} onCheckedChange={(next) => set(next)} />
        </XStack>
      );
    case 'choice':
      return (
        <YStack gap="$2">
          {titled(false)}
          <Chips label={field.title} options={field.type === 'enum' ? field.options.map((option) => ({ value: option.value, label: option.label })) : []} value={typeof value === 'string' ? value : null} onChange={(next) => set(next)} />
        </YStack>
      );
    case 'counter':
      return (
        <XStack alignItems="center" gap="$1">
          {titled(true)}
          <Button width={44} height={44} circular chromeless aria-label={`${field.title}: one less`} icon={<Icon name="minus" size={16} color={tone('$color')} />} onPress={() => count({ by: -1 })} />
          <Text fontSize={17} fontWeight="700" color="$color" minWidth={28} textAlign="center" aria-live="polite">
            {typeof value === 'number' ? value : 0}
          </Text>
          <Button width={44} height={44} circular chromeless aria-label={`${field.title}: one more`} icon={<Icon name="plus" size={16} color={tone('$color')} />} onPress={() => count({ by: 1 })} />
          <Button width={44} height={44} circular chromeless aria-label={`${field.title}: start over`} icon={<Icon name="rotate-ccw" size={16} color={tone('$muted')} />} onPress={() => count({ reset: true })} />
        </XStack>
      );
    case 'timer':
      return <TimerRow variable={variable} title={titled(true)} timer={timer} />;
    case 'number':
    case 'text':
    case 'time':
      return (
        <YStack gap="$2">
          {titled(false)}
          <Typed variable={variable} set={set} />
        </YStack>
      );
  }
}

/** A timer: what it is doing, its time counting down, and a way to start, pause, resume or stop it. */
function TimerRow({ variable, title, timer }: { variable: VariableView; title: ReactNode; timer: (action: TimerAction) => void }) {
  const tone = useTone();
  const [now, setNow] = useState(() => Date.now());
  const running = variable.value === 'running';
  // A second at a time, while it runs: nothing to count otherwise.
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);
  const left = timerLeft(variable, now);
  const state = variable.field.type === 'enum' ? (variable.field.options.find((option) => option.value === variable.value)?.label ?? '') : '';
  const button = (label: string, icon: IconName, action: TimerAction) => (
    <Button width={44} height={44} circular chromeless aria-label={`${variable.field.title}: ${label}`} icon={<Icon name={icon} size={16} color={tone(label === 'stop' ? '$muted' : '$color')} />} onPress={() => timer(action)} />
  );
  return (
    <XStack alignItems="center" gap="$1">
      {title}
      <YStack alignItems="flex-end" minWidth={64}>
        {/* Its time: counting down, held while paused — or, not running, how long it runs, quietly. */}
        <Text fontSize={17} fontWeight="700" color={variable.value === 'ended' ? '$accent' : left !== null ? '$color' : '$muted'} aria-live={variable.value === 'ended' ? 'polite' : 'off'}>
          {left !== null ? countdownText(left) : variable.value === 'ended' ? state : variable.length ? countdownText(variable.length * 1000) : state}
        </Text>
        {variable.value !== 'ended' ? (
          <Text fontSize={11} color="$muted" aria-live="polite">
            {state}
          </Text>
        ) : null}
      </YStack>
      {variable.value === 'running' ? button('pause', 'pause', { action: 'pause' }) : variable.value === 'paused' ? button('resume', 'play', { action: 'resume' }) : button('start', 'play', { action: 'start' })}
      {variable.value === 'running' || variable.value === 'paused' ? button('stop', 'square', { action: 'stop' }) : null}
    </XStack>
  );
}

/** A number, words or a time: typed, and saved when it is said to be — not as each key is pressed. */
function Typed({ variable, set }: { variable: VariableView; set: (value: Value) => void }) {
  const { field, kind, value } = variable;
  const [draft, setDraft] = useState<Value>(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft !== value && draft !== null;
  const save = () => (changed ? set(draft) : undefined);
  return (
    <XStack alignItems="center" gap="$2" flexWrap="wrap">
      {kind === 'number' ? (
        <XStack alignItems="center" gap="$1.5">
          <NumberField label={field.title} value={typeof draft === 'number' ? draft : null} onChange={(next) => setDraft(next)} />
          {field.type === 'number' && field.unit ? (
            <Text fontSize={14} color="$muted">
              {field.unit}
            </Text>
          ) : null}
        </XStack>
      ) : kind === 'time' ? (
        <TimeField label={field.title} value={typeof draft === 'string' ? draft : ''} onChange={(next) => setDraft(next)} />
      ) : (
        <Input
          flex={1}
          minWidth={180}
          size="$4"
          value={typeof draft === 'string' ? draft : ''}
          aria-label={field.title}
          backgroundColor="$background"
          borderColor="$borderColor"
          onChangeText={(next) => setDraft(next)}
          onSubmitEditing={save}
        />
      )}
      {changed ? (
        <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" onPress={save}>
          Save
        </Button>
      ) : null}
    </XStack>
  );
}
