import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { TRIGGER_KIND_ORDER, TRIGGER_KINDS, triggerSpec, type Expr, type Trigger, type TriggerSpec } from '@kraftverk/automation';
import { capitalise, haptic, Icon, IconLabel } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../../../components/tone';
import { blankCondition, ConditionField } from './Condition';
import { useEditor } from './context';
import { Fields } from './Field';

/*
  When an automation runs on its own (docs/AUTOMATION-EDITOR.md): at a time
  on chosen days, every so many minutes, when something holds (for a while),
  or when a device says something happened. None at all is an automation you start — and any can
  be started with ▶.
*/

/** The kinds to add, as the language describes them (kinds/triggers.ts): in its order, with its words and marks. */
const KINDS = TRIGGER_KIND_ORDER.map((kind) => TRIGGER_KINDS[kind] as unknown as TriggerSpec);

/**
 * Its triggers: each one line — what starts it, in its own words — opened to
 * change it, one at a time; a way to remove it, and a way to add one, which
 * opens as it is added.
 */
export function Triggers() {
  const tone = useTone();
  const editor = useEditor();
  const when = editor.draft.rule.when;
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);
  const put = (next: readonly Trigger[]) => editor.change((draft) => ({ ...draft, rule: { ...draft.rule, when: next } }));
  // A trigger changed keeps its id: what asks which started the run still means it.
  const set = (index: number, trigger: Trigger) => put(when.map((one, at) => (at === index ? (one.id ? { ...trigger, id: one.id } : trigger) : one)));

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
function TriggerFields({ trigger, set }: { trigger: Trigger; set: (trigger: Trigger) => void }) {
  return <Fields fields={triggerSpec(trigger).fields} construct={trigger} set={set} />;
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
