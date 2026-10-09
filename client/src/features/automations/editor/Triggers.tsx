import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { OWN_HOME, TRIGGER_KIND_ORDER, TRIGGER_KINDS, triggerSpec, triggerSteps, type Expr, type RuleTrigger, type TriggerSpec } from '@kraftverk/automation';
import { MAIN_PART, valueTypeOf, type ValueType } from '@kraftverk/device-sdk';
import { Chips } from '@kraftverk/ui';
import { capitalise, haptic, Icon, IconLabel } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../../../components/tone';
import { BlockList } from './Blocks';
import { Picker } from '../../../components/Picker';
import { blankCondition, ConditionField, PartChoice } from './Condition';
import { Label, ValueField, type Literal } from './fields';
import { useEditor } from './context';
import { Fields } from './Field';

/*
  When an automation runs on its own (docs/AUTOMATION-EDITOR.md): at a time
  on chosen days, every so many minutes, when something holds (for a while),
  or when a device says something happened — each with what it does beside
  it, if it does something of its own. None at all is an automation you
  start — and any can be started with ▶.
*/

/** The kinds to add, as the language describes them (kinds/triggers.ts): in its order, with its words and marks. */
const KINDS = TRIGGER_KIND_ORDER.map((kind) => TRIGGER_KINDS[kind] as unknown as TriggerSpec);

/**
 * Its triggers: each one line — what starts it, in its own words — opened to
 * change it, one at a time; what it does of its own beneath it; a way to
 * remove it, and a way to add one, which opens as it is added.
 */
export function Triggers() {
  const tone = useTone();
  const editor = useEditor();
  const when = editor.draft.rule.when;
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);
  const put = (next: readonly RuleTrigger[]) => editor.change((draft) => ({ ...draft, rule: { ...draft.rule, when: next } }));
  // A trigger changed keeps its id and its steps: its fields are its kind's, and the rest is the trigger's still.
  const set = (index: number, trigger: RuleTrigger) => put(when.map((one, at) => (at === index ? trigger : one)));

  return (
    <YStack gap="$2">
      {when.map((trigger, index) => {
        const open = opened === index;
        const kind = triggerSpec(trigger);
        const said = editor.saidTrigger(trigger);
        return (
          <YStack key={index} gap="$3" padding="$3" borderRadius="$4" borderWidth={1} borderColor={open ? '$accent' : '$borderColor'} backgroundColor="$background" role="group" aria-label={`Trigger ${index + 1}`}>
            <XStack alignItems="flex-start" gap="$2">
              <YStack flex={1}>
                <Pressable onPress={() => setOpened(open ? null : index)} label={`${open ? 'Close' : 'Change'} trigger ${index + 1}: ${said}`}>
                  {/* Each mark on the first line of its words, however many lines they run to. */}
                  <XStack alignItems="flex-start" gap="$2.5" paddingVertical={11}>
                    <YStack flex={1}>
                      <IconLabel icon={kind.icon} size={16} color={tone('$accent')} lineHeight={22} gap={10}>
                        <Text fontSize={15} color="$color" lineHeight={22}>
                          {said}
                        </Text>
                        {/* Its id, when a step asks which started it: what the configuration calls it. */}
                        {trigger.id ? (
                          <Text fontSize={13} color="$muted" lineHeight={18}>
                            Called “{trigger.id}”
                          </Text>
                        ) : null}
                      </IconLabel>
                    </YStack>
                    <YStack height={22} justifyContent="center">
                      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={tone('$muted')} />
                    </YStack>
                  </XStack>
                </Pressable>
              </YStack>
              <Button width={44} height={44} chromeless circular aria-label={`Remove trigger ${index + 1}`} icon={<Icon name="x" size={16} color={tone('$muted')} />} onPress={() => (haptic(), setOpened(null), put(when.filter((_, at) => at !== index)))} />
            </XStack>
            {open ? <TriggerFields trigger={trigger} set={(next) => set(index, next)} /> : null}
            {/* What it does of its own, beneath it — or, opened, a way to give it some. */}
            {trigger.then?.length || open ? (
              <YStack gap="$2" paddingLeft="$3" borderLeftWidth={2} borderColor="$borderColor">
                <Text fontSize={13} color="$muted" lineHeight={18}>
                  {trigger.then?.length ? 'Then' : 'Then what the automation does — or steps of its own'}
                </Text>
                <BlockList path={triggerSteps(index)} label={`What trigger ${index + 1} does`} />
              </YStack>
            ) : null}
          </YStack>
        );
      })}
      {when.length === 0 ? (
        <Text fontSize={13} color="$muted" lineHeight={19}>
          Nothing starts it on its own: it runs when you start it, or another automation does.
        </Text>
      ) : null}
      {adding ? (
        <YStack gap="$1" borderRadius="$4" borderWidth={1} borderColor="$accent" overflow="hidden" backgroundColor="$background" role="menu" aria-label="Add a trigger">
          {KINDS.map((kind) => (
            <Pressable key={kind.kind} onPress={() => (haptic(), put([...when, kind.blank()]), setOpened(when.length), setAdding(false))} label={`Add: ${kind.label}`}>
              <YStack paddingHorizontal="$3" paddingVertical="$2.5">
                <IconLabel icon={kind.icon} size={16} color={tone('$accent')} lineHeight={21} gap={10}>
                  <Text fontSize={15} fontWeight="700" color="$color" lineHeight={21}>
                    {kind.label}
                  </Text>
                  <Text fontSize={13} color="$muted" lineHeight={18}>
                    {kind.says}
                  </Text>
                </IconLabel>
              </YStack>
            </Pressable>
          ))}
          <Button alignSelf="flex-end" size="$3" minHeight={44} chromeless color="$muted" onPress={() => setAdding(false)}>
            Cancel
          </Button>
        </YStack>
      ) : (
        <Button alignSelf="flex-start" size="$3" minHeight={44} chromeless color="$accent" icon={<Icon name="plus" size={16} color={tone('$accent')} />} onPress={() => setAdding(true)}>
          Add a trigger
        </Button>
      )}
    </YStack>
  );
}

/** A trigger's fields, each drawn by what it holds — its kind's own list (kinds/triggers.ts), not one form a kind. */
function TriggerFields({ trigger, set }: { trigger: RuleTrigger; set: (trigger: RuleTrigger) => void }) {
  if ('changes' in trigger) return <ChangesFields trigger={trigger} set={set} />;
  return <Fields fields={triggerSpec(trigger).fields} construct={trigger} set={set} />;
}

/**
 * What a change watches — a reading of a part, or one of the home's
 * variables — and, if it asks, what it is from, to, and by how much at
 * least: each typed as what it watches, any unless chosen.
 */
function ChangesFields({ trigger, set }: { trigger: Extract<RuleTrigger, { changes: unknown }>; set: (trigger: RuleTrigger) => void }) {
  const editor = useEditor();
  const watched = trigger.changes;
  const variables = editor.variablesAt(OWN_HOME);
  const read = 'read' in watched ? watched.read : null;
  const bound = read ? editor.partOf(read.role) : null;
  const readings = bound ? bound.description.attributes.filter((attribute) => attribute.means && (attribute.part ?? MAIN_PART) === bound.part) : [];
  const reading = read ? (readings.find((attribute) => attribute.means === read.means) ?? null) : null;
  const variable = 'variable' in watched ? (variables.find((each) => each.key === watched.variable.key) ?? null) : null;
  const type: ValueType | null = reading ? reading.value : variable ? valueTypeOf(variable.field) : null;
  const source = read ? 'reading' : 'variable';
  /** Only what it watches, anew: a from or a to of what it watched before is not one of this. */
  const watch = (changes: Expr) => set({ ...(trigger.id ? { id: trigger.id } : {}), ...(trigger.then ? { then: trigger.then } : {}), ...(trigger.atMostEvery ? { atMostEvery: trigger.atMostEvery } : {}), changes });
  const end = (key: 'from' | 'to' | 'byAtLeast', label: string, any: string) => {
    const given = trigger[key];
    const literal = given && 'value' in given ? (given as Literal) : null;
    const start = (): Expr => (type?.type === 'number' ? { value: key === 'byAtLeast' ? 1 : (type.min ?? 0), ...(type.unit ? { unit: type.unit } : {}) } : type?.type === 'enum' ? { value: type.options[0]?.value ?? '' } : type?.type === 'boolean' ? { value: true } : { value: '' });
    return (
      <YStack gap="$1.5">
        <Label>{label}</Label>
        <Chips
          label={`${label}: any or a value`}
          options={[
            { value: false, label: any },
            { value: true, label: 'Choose' },
          ]}
          value={given !== undefined}
          onChange={(chosen) => {
            const { [key]: _was, ...rest } = trigger;
            set(chosen ? { ...rest, [key]: start() } : rest);
          }}
        />
        {given && literal ? <ValueField label={label} type={type} literal={literal} onChange={(next) => set({ ...trigger, [key]: next })} /> : null}
        {given && !literal ? (
          <Text fontSize={14} color="$color">
            {editor.saidExpr(given)}
          </Text>
        ) : null}
      </YStack>
    );
  };
  return (
    <YStack gap="$2.5">
      <YStack gap="$1.5">
        <Label>What</Label>
        <Chips
          label="What changes"
          options={[
            { value: 'reading', label: 'A reading' },
            { value: 'variable', label: 'A variable' },
          ]}
          value={source}
          onChange={(next) => (next === source ? undefined : watch(next === 'reading' ? { read: { role: '', means: '' } } : { variable: { key: '', at: OWN_HOME } }))}
        />
        {read ? (
          <>
            <PartChoice label="Which part" role={read.role} fits={(option) => option.description.attributes.some((attribute) => attribute.means && (attribute.part ?? MAIN_PART) === option.binding.part)} onRole={(role) => watch({ read: { role, means: '' } })} />
            {bound ? (
              <Picker
                label="Which reading"
                chosen={reading?.label ?? null}
                placeholder="Choose what it reports"
                options={readings.map((attribute) => ({ key: attribute.key, title: attribute.label, subtitle: attribute.value.type === 'number' && attribute.value.unit ? attribute.value.unit : undefined, value: attribute, selected: attribute === reading }))}
                onPick={(attribute) => watch({ read: { role: read.role, means: attribute.means! } })}
              />
            ) : null}
          </>
        ) : variables.length ? (
          <Picker
            label="Which variable"
            chosen={variable?.field.title ?? null}
            placeholder="Choose a variable"
            options={variables.map((each) => ({ key: each.key, title: each.field.title, value: each.key, selected: each === variable }))}
            onPick={(key) => watch({ variable: { key, at: OWN_HOME } })}
          />
        ) : (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            The home has no variables yet: add one in App settings › Variables.
          </Text>
        )}
      </YStack>
      {type ? end('from', 'From', 'Anything') : null}
      {type ? end('to', 'To', 'Anything') : null}
      {type?.type === 'number' ? end('byAtLeast', 'By at least', 'Any change') : null}
    </YStack>
  );
}

/**
 * "Only if": a condition it must meet to act, whatever started it — or none.
 * Set, it reads as one line, opened to change it; a new one opens as it is
 * added.
 */
export function OnlyIf() {
  const tone = useTone();
  const editor = useEditor();
  const condition = editor.draft.rule.if;
  const [open, setOpen] = useState(false);
  const put = (next: Expr | null) =>
    editor.change((draft) => {
      const { if: _if, ...rest } = draft.rule;
      return { ...draft, rule: next ? { ...rest, if: next } : rest };
    });
  if (!condition) {
    return (
      <Button alignSelf="flex-start" size="$3" minHeight={44} chromeless color="$accent" icon={<Icon name="plus" size={16} color={tone('$accent')} />} onPress={() => (put(blankCondition(null)), setOpen(true))}>
        Add a condition it must meet
      </Button>
    );
  }
  const said = editor.saidExpr(condition);
  return (
    <YStack gap="$3" padding="$3" borderRadius="$4" borderWidth={1} borderColor={open ? '$accent' : '$borderColor'} backgroundColor="$background">
      <XStack alignItems="flex-start" gap="$2">
        <YStack flex={1}>
          <Pressable onPress={() => setOpen((was) => !was)} label={`${open ? 'Close' : 'Change'} the condition: ${said}`}>
            <XStack alignItems="flex-start" gap="$2.5" paddingVertical={11}>
              <Text flex={1} fontSize={15} color="$color" lineHeight={22}>
                {capitalise(said)}
              </Text>
              <YStack height={22} justifyContent="center">
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={tone('$muted')} />
              </YStack>
            </XStack>
          </Pressable>
        </YStack>
        <Button width={44} height={44} chromeless circular aria-label="Remove the condition" icon={<Icon name="x" size={16} color={tone('$muted')} />} onPress={() => (haptic(), setOpen(false), put(null))} />
      </XStack>
      {open ? <ConditionField label="Only if" expr={condition} onChange={put} /> : null}
    </YStack>
  );
}
