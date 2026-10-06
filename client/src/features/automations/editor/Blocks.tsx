import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import {
  automationRole,
  blankStep,
  branchesOf,
  insertStep,
  kindsFor,
  listAt,
  mayWait,
  moveStep,
  removeStep,
  SEQUENCE_LIMITS,
  STEP_KINDS,
  stepKind,
  stepSpec,
  within,
  withStep,
  writtenAttribute,
  type Branch,
  type Command,
  type Expr,
  type ListPath,
  type Step,
  type StepKind,
  type Write,
} from '@kraftverk/automation';
import { capabilitiesOf, capabilityIn, isScalarType, MAIN_PART, type DeviceDescription, type Value } from '@kraftverk/device-sdk';
import { Chips, haptic, Icon, IconLabel } from '@kraftverk/ui';

import { Picker } from '../../../components/Picker';
import { Pressable } from '../../../components/Pressable';
import { useTone } from '../../../components/tone';
import { confirmAction } from '../../../platform/confirm';
import { ConditionField } from './Condition';
import { pickPart, useEditor } from './context';
import { Fields } from './Field';
import { DurationField, durationOf, Label, ValueField } from './fields';


/*
  The blocks of a sequence (docs/AUTOMATION-EDITOR.md): each step a card —
  its kind, what it does in words, its fields when opened — numbered and
  nested as the automation's card shows them. Every list ends with a way to
  add a step, of the kinds that list may take; every block moves up and down
  its list, and is removed.
*/

/** The steps at a place, each a block, and a way to add one. */
export function BlockList({ path, label }: { path: ListPath; label: string }) {
  const editor = useEditor();
  const steps = listAt(editor.draft.rule, path);
  const [opened, setOpened] = useState<number | null>(null);
  return (
    <YStack gap="$2" role="list" aria-label={label}>
      {steps.map((step, index) => (
        <Block key={`${index}:${stepKind(step)}`} path={path} index={index} step={step} count={steps.length} open={opened === index} onToggle={() => setOpened(opened === index ? null : index)} />
      ))}
      <AddStep
        path={path}
        list={label}
        onAdded={() => {
          // The new block opens, so its fields are there to fill.
          setOpened(steps.length);
        }}
      />
    </YStack>
  );
}

/**
 * One block: its number, its kind's mark and its words — a tap opens its
 * fields — and ⋯ for moving it and removing it, the only actions it has. The
 * lists it holds beneath, on a thin rail, so nesting costs little width.
 */
function Block({ path, index, step, count, open, onToggle }: { path: ListPath; index: number; step: Step; count: number; open: boolean; onToggle: () => void }) {
  const tone = useTone();
  const editor = useEditor();
  const [menu, setMenu] = useState(false);
  const kind = stepKind(step);
  const words = editor.said(step);
  const set = (next: Step) => editor.change((draft) => ({ ...draft, rule: withStep(draft.rule, path, index, () => next) }));
  const move = (by: -1 | 1) => (haptic(), setMenu(false), editor.change((draft) => ({ ...draft, rule: moveStep(draft.rule, path, index, by) })));
  const remove = () => (haptic(), setMenu(false), editor.change((draft) => ({ ...draft, rule: removeStep(draft.rule, path, index) })));
  const numbered = path.trail.length === 0 && path.root !== 'otherwise';
  const actions = [
    ...(index > 0 ? [{ icon: 'arrow-up' as const, label: 'Move up', onPress: () => move(-1) }] : []),
    ...(index < count - 1 ? [{ icon: 'arrow-down' as const, label: 'Move down', onPress: () => move(1) }] : []),
    { icon: 'trash-2' as const, label: 'Remove', danger: true, onPress: remove },
  ];

  return (
    <YStack role="listitem" aria-label={`${STEP_KINDS[kind].label}: ${words}`} gap="$3" padding="$3" borderRadius="$4" borderWidth={1} borderColor={open ? '$accent' : '$borderColor'} backgroundColor="$background">
      <XStack gap="$2.5" alignItems="flex-start">
        {numbered ? (
          <YStack height={44} justifyContent="center">
            <YStack width={24} height={24} borderRadius={12} backgroundColor="$accent" alignItems="center" justifyContent="center">
              <Text fontSize={12} lineHeight={24} fontWeight="800" color="$background">
                {index + 1}
              </Text>
            </YStack>
          </YStack>
        ) : null}
        <YStack flex={1}>
          <Pressable onPress={onToggle} label={`${open ? 'Close' : 'Open'} step: ${words}`}>
            {/* Its first line centred where the number and ⋯ are, however many lines follow. */}
            <YStack paddingVertical={11}>
              <IconLabel icon={STEP_KINDS[kind].icon} size={16} color={tone('$muted')} lineHeight={22}>
                <Text fontSize={15} color="$color" lineHeight={22}>
                  {words}
                </Text>
              </IconLabel>
            </YStack>
          </Pressable>
        </YStack>
        <Button width={44} height={44} circular chromeless aria-label={`Actions for step: ${words}`} aria-expanded={menu} icon={<Icon name="more-horizontal" size={18} color={tone('$muted')} />} onPress={() => (haptic(), setMenu((was) => !was))} />
      </XStack>

      {menu ? (
        <XStack gap="$2" flexWrap="wrap" role="menu" aria-label={`Actions for step: ${words}`}>
          {actions.map((action) => (
            <Button
              key={action.label}
              size="$3"
              minHeight={44}
              backgroundColor="$card"
              borderWidth={1}
              borderColor={action.danger ? '$danger' : '$borderColor'}
              color={action.danger ? '$danger' : '$color'}
              icon={<Icon name={action.icon} size={15} color={tone(action.danger ? '$danger' : '$color')} />}
              aria-label={`${action.label}: ${words}`}
              onPress={action.onPress}
            >
              {action.label}
            </Button>
          ))}
        </XStack>
      ) : null}

      {open ? <StepFields path={path} step={step} set={set} /> : null}

      {/* The lists it holds: always shown, so a sequence's shape is seen whole. */}
      {branchesOf(step).map(({ field }) => (
        <YStack key={field.key} gap="$2" paddingLeft="$2.5" borderLeftWidth={2} borderColor="$borderColor">
          <Text fontSize={13} fontWeight="600" color="$muted">
            {field.label}
          </Text>
          <BlockList path={within(path, index, field.data.at(-1) as Branch)} label={`${words}: ${field.label}`} />
        </YStack>
      ))}
    </YStack>
  );
}

/**
 * A block's fields: its kind's own, each drawn by what it holds (kinds/steps.ts)
 * — or, for a kind whose choices depend on the part (a command, a setting) or
 * on the automations there are, its own form.
 */
function StepFields({ path, step, set }: { path: ListPath; step: Step; set: (step: Step) => void }) {
  if ('command' in step) return <CommandFields command={step.command} set={(command) => set({ command })} />;
  if ('write' in step) return <WriteFields write={step.write} set={(write) => set({ write })} />;
  if ('start' in step) return <StartFields start={step.start} waits={mayWait(path)} set={(start) => set({ start })} />;
  return <Fields fields={stepSpec(step).fields} construct={step} set={set} />;
}

/** How long, as one field, with the most it may be: an hour for a wait, ten minutes for one try. */
function Seconds({ label, expr, set, max = SEQUENCE_LIMITS.waitSeconds }: { label: string; expr: Expr; set: (expr: Expr) => void; max?: number }) {
  return (
    <YStack gap="$1.5">
      <Label>{label}</Label>
      <DurationField label={label} value={durationOf(expr)} max={max} onChange={(next) => set(next ?? { value: 0, unit: 's' })} />
    </YStack>
  );
}

/** A part picker for a block: what fills its role, among the parts that can do what it needs. */
function PartField({ role, fits, onRole }: { role: string; fits: Parameters<ReturnType<typeof useEditor>['parts']>[0]; onRole: (role: string) => void }) {
  const editor = useEditor();
  return (
    <YStack gap="$1">
      <Label>Which part</Label>
      <Picker
        label="Which part"
        chosen={editor.draft.rule.roles[role] ? editor.name(role) : null}
        placeholder="Choose a part"
        options={editor.parts(fits).map((option) => ({ key: option.key, title: option.title, subtitle: option.subtitle, value: option, selected: option.role === role }))}
        onPick={(option) => {
          const picked = pickPart(editor.draft, option);
          editor.change(() => picked.draft);
          onRole(picked.role);
        }}
      />
    </YStack>
  );
}

/** A command: a part, one of the commands it offers, and what it is told. */
function CommandFields({ command, set }: { command: Command; set: (command: Command) => void }) {
  const editor = useEditor();
  const bound = editor.partOf(command.role);
  // Every command the part offers, by its capability: "Switch: on or off".
  const offered = bound
    ? capabilitiesOf(bound.description, bound.part).flatMap((capability) => {
        const spec = capabilityIn(bound.description, capability);
        return spec ? Object.entries(spec.commands).map(([name, declared]) => ({ capability, name, label: `${spec.label}: ${name}`, args: declared.args })) : [];
      })
    : [];
  const chosen = offered.find((candidate) => candidate.capability === command.capability && candidate.name === command.command) ?? null;
  const isSwitch = command.capability === 'switch' && command.command === 'set';
  return (
    <YStack gap="$2.5">
      <PartField role={command.role} fits={(description, part) => capabilitiesOf(description, part).some((capability) => Object.keys(capabilityIn(description, capability)?.commands ?? {}).length > 0)} onRole={(role) => set({ ...command, role })} />
      {bound && offered.length > 1 ? (
        <YStack gap="$1">
          <Label>Which command</Label>
          <Picker
            label="Which command"
            chosen={chosen?.label ?? null}
            placeholder="Choose a command"
            options={offered.map((candidate) => ({ key: `${candidate.capability}.${candidate.name}`, title: candidate.label, value: candidate, selected: candidate === chosen }))}
            onPick={(candidate) =>
              set({ role: command.role, capability: candidate.capability as Command['capability'], command: candidate.name, args: Object.fromEntries(Object.entries(candidate.args).map(([name, type]) => [name, { value: startValue(type) }])) })
            }
          />
        </YStack>
      ) : null}
      {bound
        ? Object.entries(chosen?.args ?? {}).map(([name, type]) => {
            const arg = command.args[name];
            return (
              <YStack key={name} gap="$1">
                <Label>{isSwitch ? 'Turn it' : name}</Label>
                <ArgField label={isSwitch ? 'Turn it' : name} type={type} expr={arg} switchLike={isSwitch} onChange={(next) => set({ ...command, args: { ...command.args, [name]: next } })} />
              </YStack>
            );
          })
        : null}
    </YStack>
  );
}

/**
 * A value a step sends: typed as a value — or, when it is worked out as the
 * step runs ("on if the charge is below 50 %, off if not", as a copied charge
 * window has it), kept as that: a condition stays a condition to change,
 * anything else is said in words, and making it a fixed value is asked first.
 * Never replaced by a tap.
 */
function ArgField({ label, type, expr, switchLike, onChange }: { label: string; type: Parameters<typeof ValueField>[0]['type']; expr: Expr | undefined; switchLike?: boolean; onChange: (expr: Expr) => void }) {
  const editor = useEditor();
  if (!expr || 'value' in expr) return <ValueField label={label} type={type} literal={expr && 'value' in expr ? expr : null} onChange={onChange} />;
  const fixed = async () => {
    const said = editor.saidExpr(expr);
    if (await confirmAction('Use a fixed value instead?', `Now it is worked out as it runs: ${said}. A fixed value is the same every time.`, 'Use a fixed value')) onChange({ value: startValue(type) });
  };
  const condition = type?.type === 'boolean';
  return (
    <YStack gap="$2">
      {condition ? (
        <>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {switchLike ? 'On while this holds, off when it does not:' : 'Yes while this holds, no when it does not:'}
          </Text>
          <ConditionField label={label} expr={expr} onChange={onChange} />
        </>
      ) : (
        <Text fontSize={15} color="$color" lineHeight={21}>
          {editor.saidExpr(expr)}
        </Text>
      )}
      <Button alignSelf="flex-start" size="$3" chromeless color="$accent" onPress={() => void fixed()}>
        Use a fixed value instead
      </Button>
    </YStack>
  );
}

/** A value to start a field from: the first option, yes, nought, nothing. */
const startValue = (type: Parameters<typeof ValueField>[0]['type']): Value =>
  !type ? null : type.type === 'enum' ? (type.options[0]?.value ?? null) : type.type === 'boolean' ? true : type.type === 'number' ? (type.min ?? 0) : type.type === 'string' ? '' : null;

/**
 * A setting changed: a part, one of the settings it may be told — never one
 * that can harm it — and its value. One a recipe names by its meaning shows as
 * the part's setting that has it; another picked is named by its key.
 */
function WriteFields({ write, set }: { write: Write; set: (write: Write) => void }) {
  const editor = useEditor();
  const bound = editor.partOf(write.role);
  const settingsOf = (description: DeviceDescription, part: string) =>
    description.attributes.filter((attribute) => attribute.access === 'write' && !attribute.dangerous && isScalarType(attribute.value) && (attribute.part ?? MAIN_PART) === part);
  const settings = bound ? settingsOf(bound.description, bound.part) : [];
  const named = bound ? writtenAttribute(bound.description, bound.part, write) : null;
  const chosen = settings.find((attribute) => attribute === named) ?? null;
  return (
    <YStack gap="$2.5">
      <PartField role={write.role} fits={(description, part) => settingsOf(description, part).length > 0} onRole={(role) => set({ role, key: '', value: write.value })} />
      {bound ? (
        <YStack gap="$1">
          <Label>Which setting</Label>
          <Picker
            label="Which setting"
            chosen={chosen?.label ?? null}
            placeholder="Choose a setting"
            options={settings.map((attribute) => ({ key: attribute.key, title: attribute.label, subtitle: attribute.section ?? attribute.description, value: attribute, selected: attribute === chosen }))}
            onPick={(attribute) => set({ role: write.role, key: attribute.key, value: { value: startValue(attribute.value) } })}
          />
        </YStack>
      ) : null}
      {chosen ? (
        <YStack gap="$1">
          <Label>Set it to</Label>
          <ArgField label="Set it to" type={chosen.value} expr={write.value} onChange={(next) => set({ ...write, value: next })} />
        </YStack>
      ) : null}
    </YStack>
  );
}

/** Another automation started: which, and whether this one waits for it to end — at most so long. */
function StartFields({ start, waits, set }: { start: Extract<Step, { start: unknown }>['start']; waits: boolean; set: (start: Extract<Step, { start: unknown }>['start']) => void }) {
  const editor = useEditor();
  const chosen = editor.draft.starts[start.role];
  return (
    <YStack gap="$2.5">
      <YStack gap="$1">
        <Label>Which automation</Label>
        <Picker
          label="Which automation"
          chosen={chosen ? editor.name(start.role) : null}
          placeholder="Choose an automation"
          options={editor.automations.map((automation) => ({ key: automation.id, title: automation.name, subtitle: automation.sentence, value: automation, selected: automation.id === chosen }))}
          onPick={(automation) => {
            const picked = automationRole(editor.draft, automation.id);
            editor.change(() => picked.draft);
            set({ ...start, role: picked.role });
          }}
        />
      </YStack>
      {waits ? (
        <YStack gap="$1.5">
          <Chips
            label="Wait for it to end"
            options={[
              { value: false, label: 'Start it, and go on' },
              { value: true, label: 'Wait until it ends' },
            ]}
            value={start.andWait !== undefined}
            onChange={(wait) => set(wait ? { role: start.role, andWait: { value: 10, unit: 'min' } } : { role: start.role })}
          />
          {start.andWait ? <Seconds label="At most" expr={start.andWait} set={(andWait) => set({ ...start, andWait })} /> : null}
        </YStack>
      ) : null}
    </YStack>
  );
}

/**
 * "Add a step": the kinds this list may take, each with what it does. `list`:
 * the list's name, so each of a page's several Add a step buttons says where
 * it adds.
 */
function AddStep({ path, list, onAdded }: { path: ListPath; list: string; onAdded: () => void }) {
  const tone = useTone();
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  const add = (kind: StepKind) => {
    haptic();
    // A block about a part starts about one the rule already uses that can do what it does — a setting to
    // change, a command to take — when there is one; otherwise its part is chosen in it.
    const able = (role: string) => {
      const bound = editor.partOf(role);
      if (!bound) return false;
      if (kind === 'write') return bound.description.attributes.some((attribute) => attribute.access === 'write' && !attribute.dangerous && (attribute.part ?? MAIN_PART) === bound.part);
      if (kind === 'command') return capabilitiesOf(bound.description, bound.part).some((capability) => Object.keys(capabilityIn(bound.description, capability)?.commands ?? {}).length > 0);
      return true;
    };
    const role = kind === 'start' || kind === 'wait' ? null : (Object.keys(editor.draft.roles).find(able) ?? null);
    editor.change((draft) => ({ ...draft, rule: insertStep(draft.rule, path, listAt(draft.rule, path).length, blankStep(kind, role)) }));
    setOpen(false);
    onAdded();
  };
  if (!open) {
    // A trigger's own list says whose it is: beside the automation's, "Add a step" would be two of one.
    const text = typeof path.root === 'object' && !path.trail.length ? 'Add a step to this trigger' : 'Add a step';
    return (
      <Button alignSelf="flex-start" size="$3" minHeight={44} chromeless color="$accent" icon={<Icon name="plus" size={16} color={tone('$accent')} />} aria-label={`${text}: ${list}`} onPress={() => setOpen(true)}>
        {text}
      </Button>
    );
  }
  return (
    <YStack borderRadius="$4" borderWidth={1} borderColor="$accent" overflow="hidden" backgroundColor="$background" role="menu" aria-label={`Add a step: ${list}`}>
      {kindsFor(path).map((kind, index) => (
        <YStack key={kind} borderTopWidth={index ? 1 : 0} borderColor="$borderColor">
          <Pressable onPress={() => add(kind)} label={`Add: ${STEP_KINDS[kind].label}`}>
            <YStack paddingHorizontal="$3" paddingVertical="$2.5">
              <IconLabel icon={STEP_KINDS[kind].icon} size={16} color={tone('$accent')} lineHeight={21} gap={10}>
                <Text fontSize={15} fontWeight="700" color="$color" lineHeight={21}>
                  {STEP_KINDS[kind].label}
                </Text>
                <Text fontSize={13} color="$muted" lineHeight={18}>
                  {STEP_KINDS[kind].says}
                </Text>
              </IconLabel>
            </YStack>
          </Pressable>
        </YStack>
      ))}
      <XStack borderTopWidth={1} borderColor="$borderColor" justifyContent="flex-end" padding="$1">
        <Button size="$3" minHeight={44} chromeless color="$muted" onPress={() => setOpen(false)}>
          Cancel
        </Button>
      </XStack>
    </YStack>
  );
}
