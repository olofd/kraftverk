import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { EVERY_MINUTES, MAIN_PART, type Expr, type Trigger } from '@kraftverk/device-sdk';
import { haptic, Icon } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../looks';
import { ConditionField } from './Condition';
import { pickPart, useEditor } from './context';
import { Chips, DaysField, Label, NumberField, Picker, TimeField } from './fields';

/*
  When an automation runs on its own (docs/AUTOMATION-EDITOR.md): at a time
  on chosen days, every so many minutes, when something holds (for a while),
  or when a device says something happened. None at all is an automation you start — and any can
  be started with ▶.
*/

type TriggerKind = 'at' | 'every' | 'becomes' | 'event';

const TRIGGER_KINDS: { value: TriggerKind; label: string; says: string; icon: 'clock' | 'repeat' | 'activity' | 'bell' }[] = [
  { value: 'at', label: 'At a time', says: 'A time of day, every day or on the days you choose.', icon: 'clock' },
  { value: 'every', label: 'Every so often', says: 'Every so many minutes, on the clock: every 15 is on the hour, and at :15, :30 and :45.', icon: 'repeat' },
  { value: 'becomes', label: 'When something holds', says: 'When a condition turns true — and, if you like, has stayed true a while.', icon: 'activity' },
  { value: 'event', label: 'When a device says so', says: 'When a device reports something happened: mains lost, a charge started.', icon: 'bell' },
];

const blankTrigger = (kind: TriggerKind): Trigger =>
  kind === 'at' ? { at: { value: '07:00' } } : kind === 'every' ? { every: { value: 15 } } : kind === 'becomes' ? { becomes: { value: true } } : { event: { role: '', event: '' } };

/** Its triggers, each with its fields and a way to remove it, and a way to add one. */
export function Triggers() {
  const tone = useTone();
  const editor = useEditor();
  const when = editor.draft.rule.when;
  const [adding, setAdding] = useState(false);
  const put = (next: readonly Trigger[]) => editor.change((draft) => ({ ...draft, rule: { ...draft.rule, when: next } }));
  const set = (index: number, trigger: Trigger) => put(when.map((one, at) => (at === index ? trigger : one)));

  return (
    <YStack gap="$2">
      {when.map((trigger, index) => (
        <YStack key={index} gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$borderColor" backgroundColor="$card" role="group" aria-label={`Trigger ${index + 1}`}>
          <XStack alignItems="center" justifyContent="space-between" gap="$2">
            <Text fontSize={11} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
              {TRIGGER_KINDS.find((kind) => kind.value in trigger)?.label}
            </Text>
            <Button size="$2" chromeless circular aria-label={`Remove trigger ${index + 1}`} icon={<Icon name="trash-2" size={14} color={tone('$danger')} />} onPress={() => (haptic(), put(when.filter((_, at) => at !== index)))} />
          </XStack>
          <TriggerFields trigger={trigger} set={(next) => set(index, next)} />
        </YStack>
      ))}
      {when.length === 0 ? (
        <Text fontSize={13} color="$muted" lineHeight={19}>
          Nothing starts it on its own: it runs when you start it, or another automation does.
        </Text>
      ) : null}
      {adding ? (
        <YStack gap="$1" padding="$2" borderRadius="$3" borderWidth={1} borderColor="$accent" role="menu" aria-label="Add a trigger">
          {TRIGGER_KINDS.map((kind) => (
            <Pressable key={kind.value} onPress={() => (haptic(), put([...when, blankTrigger(kind.value)]), setAdding(false))} label={`Add: ${kind.label}`}>
              <XStack gap="$2.5" alignItems="flex-start" paddingHorizontal="$2" paddingVertical="$1.5">
                <Icon name={kind.icon} size={15} color={tone('$accent')} style={{ marginTop: 2 }} />
                <YStack flex={1} gap={1}>
                  <Text fontSize={14} fontWeight="700" color="$color">
                    {kind.label}
                  </Text>
                  <Text fontSize={12} color="$muted" lineHeight={17}>
                    {kind.says}
                  </Text>
                </YStack>
              </XStack>
            </Pressable>
          ))}
          <Button alignSelf="flex-end" size="$2" chromeless color="$muted" onPress={() => setAdding(false)}>
            Cancel
          </Button>
        </YStack>
      ) : (
        <Button alignSelf="flex-start" size="$2" chromeless color="$accent" icon={<Icon name="plus" size={13} color={tone('$accent')} />} onPress={() => setAdding(true)}>
          Add a trigger
        </Button>
      )}
    </YStack>
  );
}

function TriggerFields({ trigger, set }: { trigger: Trigger; set: (trigger: Trigger) => void }) {
  const editor = useEditor();
  if ('at' in trigger) {
    const time = 'value' in trigger.at && typeof trigger.at.value === 'string' ? trigger.at.value : '07:00';
    return (
      <YStack gap="$2.5">
        <YStack gap="$1">
          <Label>At</Label>
          <TimeField value={time} onChange={(at) => set({ ...trigger, at: { value: at } })} />
        </YStack>
        <YStack gap="$1">
          <Label>On</Label>
          <DaysField
            value={trigger.days}
            onChange={(days) => {
              const { days: _days, ...rest } = trigger;
              set(days ? { ...rest, days } : rest);
            }}
          />
        </YStack>
      </YStack>
    );
  }
  if ('every' in trigger) {
    const minutes = 'value' in trigger.every && typeof trigger.every.value === 'number' ? trigger.every.value : null;
    return (
      <YStack gap="$1">
        <Label>Every</Label>
        <NumberField label="Every" value={minutes} unit="min" onChange={(next) => set({ every: { value: next } })} />
        <Text fontSize={12} color="$muted">
          From {EVERY_MINUTES.min} minutes to {EVERY_MINUTES.max / 60} hours. Add a condition it must meet to keep it to some hours.
        </Text>
      </YStack>
    );
  }
  if ('becomes' in trigger) {
    const minutes = trigger.heldForMinutes && 'value' in trigger.heldForMinutes && typeof trigger.heldForMinutes.value === 'number' ? trigger.heldForMinutes.value : 0;
    return (
      <YStack gap="$2.5">
        <ConditionField label="When" expr={trigger.becomes} onChange={(becomes: Expr) => set({ ...trigger, becomes })} />
        <YStack gap="$1">
          <Label>And it has held for</Label>
          <NumberField
            label="And it has held for"
            value={minutes}
            unit="min"
            onChange={(next) => set(next ? { becomes: trigger.becomes, heldForMinutes: { value: next } } : { becomes: trigger.becomes })}
          />
        </YStack>
      </YStack>
    );
  }
  // A device saying something happened: a part that declares events, and one of them.
  const bound = editor.partOf(trigger.event.role);
  const events = bound ? (bound.description.events ?? []).filter((event) => (event.part ?? MAIN_PART) === bound.part) : [];
  return (
    <YStack gap="$2.5">
      <YStack gap="$1">
        <Label>Which part</Label>
        <Picker
          label="Which part"
          chosen={editor.draft.rule.roles[trigger.event.role] ? editor.name(trigger.event.role) : null}
          placeholder="Choose a part"
          options={editor
            .parts((description, part) => (description.events ?? []).some((event) => (event.part ?? MAIN_PART) === part))
            .map((option) => ({ key: option.key, title: option.title, subtitle: option.subtitle, value: option, selected: option.role === trigger.event.role }))}
          onPick={(option) => {
            const picked = pickPart(editor.draft, option);
            editor.change(() => picked.draft);
            set({ event: { role: picked.role, event: '' } });
          }}
        />
      </YStack>
      {bound ? (
        <YStack gap="$1">
          <Label>Says</Label>
          <Chips label="Says" options={events.map((event) => ({ value: event.id, label: event.label }))} value={trigger.event.event || null} onChange={(event) => set({ event: { ...trigger.event, event } })} />
        </YStack>
      ) : null}
    </YStack>
  );
}

/** "Only if": a condition it must meet to act, whatever started it — or none. */
export function OnlyIf() {
  const tone = useTone();
  const editor = useEditor();
  const condition = editor.draft.rule.if;
  const put = (next: Expr | null) =>
    editor.change((draft) => {
      const { if: _if, ...rest } = draft.rule;
      return { ...draft, rule: next ? { ...rest, if: next } : rest };
    });
  return condition ? (
    <YStack gap="$2">
      <ConditionField label="Only if" expr={condition} onChange={put} />
      <Button alignSelf="flex-start" size="$2" chromeless color="$danger" icon={<Icon name="x" size={13} color={tone('$danger')} />} onPress={() => put(null)}>
        No condition
      </Button>
    </YStack>
  ) : (
    <Button alignSelf="flex-start" size="$2" chromeless color="$accent" icon={<Icon name="plus" size={13} color={tone('$accent')} />} onPress={() => put({ reachable: Object.keys(editor.draft.roles)[0] ?? '' })}>
      Add a condition it must meet
    </Button>
  );
}
