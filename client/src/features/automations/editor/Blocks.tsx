import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import {
  capabilitiesOf,
  capabilityIn,
  isScalarType,
  MAIN_PART,
  stepKind,
  writtenAttribute,
  type Command,
  type DeviceDescription,
  type Expr,
  type Step,
  type StepKind,
  type Value,
  type Write,
} from '@kraftverk/device-sdk';
import { haptic, Icon } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { confirmAction } from '../../../lib/confirm';
import { KIND as KIND_ICON, useTone } from '../looks';
import { ConditionField } from './Condition';
import { pickPart, useEditor } from './context';
import { automationRole, blankStep, insertStep, KINDS, kindsFor, listAt, mayWait, moveStep, removeStep, secondsOf, within, withStep, type Branch, type ListPath } from './draft';
import { Chips, Label, NumberField, Picker, SecondsField, ValueField } from './fields';

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
        onAdded={() => {
          // The new block opens, so its fields are there to fill.
          setOpened(steps.length);
        }}
      />
    </YStack>
  );
}

/** One block: a card with its kind and words, opened to its fields; the lists it holds beneath. */
function Block({ path, index, step, count, open, onToggle }: { path: ListPath; index: number; step: Step; count: number; open: boolean; onToggle: () => void }) {
  const tone = useTone();
  const editor = useEditor();
  const kind = stepKind(step);
  const words = editor.said(step);
  const set = (next: Step) => editor.change((draft) => ({ ...draft, rule: withStep(draft.rule, path, index, () => next) }));
  const move = (by: -1 | 1) => (haptic(), editor.change((draft) => ({ ...draft, rule: moveStep(draft.rule, path, index, by) })));
  const remove = () => (haptic(), editor.change((draft) => ({ ...draft, rule: removeStep(draft.rule, path, index) })));
  const numbered = path.trail.length === 0 && path.root === 'then';

  return (
    <YStack role="listitem" aria-label={`${KINDS[kind].label}: ${words}`} gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor={open ? '$accent' : '$borderColor'} backgroundColor="$card">
      <XStack gap="$2.5" alignItems="flex-start">
        {numbered ? (
          <YStack width={22} height={22} borderRadius={11} backgroundColor="$accent" alignItems="center" justifyContent="center" marginTop={1}>
            <Text fontSize={12} fontWeight="800" color="$background">
              {index + 1}
            </Text>
          </YStack>
        ) : null}
        <Icon name={KIND_ICON[kind]} size={15} color={tone('$muted')} style={{ marginTop: 4 }} />
        <YStack flex={1}>
          <Pressable onPress={onToggle} label={`${open ? 'Close' : 'Open'} step: ${words}`}>
            <YStack gap={1}>
              <Text fontSize={11} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
                {KINDS[kind].label}
              </Text>
              <Text fontSize={14} color="$color" lineHeight={20}>
                {words}
              </Text>
            </YStack>
          </Pressable>
        </YStack>
        <XStack gap={2}>
          <Button size="$2" chromeless circular disabled={index === 0} opacity={index === 0 ? 0.3 : 1} aria-label={`Move up: ${words}`} icon={<Icon name="arrow-up" size={14} color={tone('$muted')} />} onPress={() => move(-1)} />
          <Button size="$2" chromeless circular disabled={index === count - 1} opacity={index === count - 1 ? 0.3 : 1} aria-label={`Move down: ${words}`} icon={<Icon name="arrow-down" size={14} color={tone('$muted')} />} onPress={() => move(1)} />
          <Button size="$2" chromeless circular aria-label={`Remove: ${words}`} icon={<Icon name="trash-2" size={14} color={tone('$danger')} />} onPress={remove} />
        </XStack>
      </XStack>

      {open ? <Fields path={path} step={step} set={set} /> : null}

      {/* The lists it holds: always shown, so a sequence's shape is seen whole. */}
      {branchesOf(step).map(({ branch, label }) => (
        <YStack key={branch} gap="$1.5" marginLeft="$3" paddingLeft="$3" borderLeftWidth={2} borderColor="$borderColor">
          <Text fontSize={11} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
            {label}
          </Text>
          <BlockList path={within(path, index, branch)} label={`${words}: ${label}`} />
        </YStack>
      ))}
    </YStack>
  );
}

/** The lists a step holds, each with what it is for. */
function branchesOf(step: Step): { branch: Branch; label: string }[] {
  if ('ensure' in step) return [{ branch: 'retry', label: 'Each time it is not so' }];
  if ('choose' in step)
    return [
      { branch: 'then', label: 'Then' },
      { branch: 'else', label: 'Otherwise' },
    ];
  if ('watch' in step)
    return [
      { branch: 'then', label: 'If it stays so' },
      { branch: 'else', label: 'If not' },
    ];
  return [];
}

/** A block's fields, by its kind. */
function Fields({ path, step, set }: { path: ListPath; step: Step; set: (step: Step) => void }) {
  if ('command' in step) return <CommandFields command={step.command} set={(command) => set({ command })} />;
  if ('write' in step) return <WriteFields write={step.write} set={(write) => set({ write })} />;
  if ('start' in step) return <StartFields start={step.start} waits={mayWait(path)} set={(start) => set({ start })} />;
  if ('wait' in step) return <Seconds label="For" expr={step.wait.seconds} set={(seconds) => set({ wait: { seconds } })} />;
  if ('waitUntil' in step) {
    const { condition, atMostSeconds } = step.waitUntil;
    return (
      <YStack gap="$2.5">
        <Label>Until</Label>
        <ConditionField label="Wait until" expr={condition} onChange={(next) => set({ waitUntil: { condition: next, atMostSeconds } })} />
        <Seconds label="At most" expr={atMostSeconds} set={(next) => set({ waitUntil: { condition, atMostSeconds: next } })} />
      </YStack>
    );
  }
  if ('ensure' in step) {
    const { condition, withinSeconds, tries } = step.ensure;
    const put = (changes: Partial<typeof step.ensure>) => set({ ensure: { ...step.ensure, ...changes } });
    return (
      <YStack gap="$2.5">
        <Label>That</Label>
        <ConditionField label="Make sure" expr={condition} onChange={(next) => put({ condition: next })} />
        <Seconds label="Each try is given" expr={withinSeconds} set={(next) => put({ withinSeconds: next })} />
        <YStack gap="$1">
          <Label>Tries at most</Label>
          <NumberField label="Tries at most" value={secondsOf(tries)} onChange={(next) => put({ tries: { value: next } })} />
        </YStack>
      </YStack>
    );
  }
  if ('choose' in step) {
    return (
      <YStack gap="$1.5">
        <Label>If</Label>
        <ConditionField label="If" expr={step.choose.if} onChange={(next) => set({ choose: { ...step.choose, if: next } })} />
      </YStack>
    );
  }
  const { condition, seconds } = step.watch;
  return (
    <YStack gap="$2.5">
      <Label>Whether</Label>
      <ConditionField label="Watch whether" expr={condition} onChange={(next) => set({ watch: { ...step.watch, condition: next } })} />
      <Seconds label="For" expr={seconds} set={(next) => set({ watch: { ...step.watch, seconds: next } })} />
    </YStack>
  );
}

function Seconds({ label, expr, set }: { label: string; expr: Expr; set: (expr: Expr) => void }) {
  return (
    <YStack gap="$1">
      <Label>{label}</Label>
      <SecondsField label={label} value={secondsOf(expr)} onChange={(next) => set({ value: next })} />
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
  if (!expr || 'value' in expr) return <ValueField label={label} type={type} value={expr && 'value' in expr ? expr.value : null} onChange={(next) => onChange({ value: next })} />;
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
            value={start.waitSeconds !== undefined}
            onChange={(wait) => set(wait ? { role: start.role, waitSeconds: { value: 600 } } : { role: start.role })}
          />
          {start.waitSeconds ? <Seconds label="At most" expr={start.waitSeconds} set={(waitSeconds) => set({ ...start, waitSeconds })} /> : null}
        </YStack>
      ) : null}
    </YStack>
  );
}

/** "Add a step": the kinds this list may take, each with what it does. */
function AddStep({ path, onAdded }: { path: ListPath; onAdded: () => void }) {
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
    return (
      <Button alignSelf="flex-start" size="$2" chromeless color="$accent" icon={<Icon name="plus" size={13} color={tone('$accent')} />} onPress={() => setOpen(true)}>
        Add a step
      </Button>
    );
  }
  return (
    <YStack gap="$1" padding="$2" borderRadius="$3" borderWidth={1} borderColor="$accent" role="menu" aria-label="Add a step">
      {kindsFor(path).map((kind) => (
        <Pressable key={kind} onPress={() => add(kind)} label={`Add: ${KINDS[kind].label}`}>
          <XStack gap="$2.5" alignItems="flex-start" paddingHorizontal="$2" paddingVertical="$1.5">
            <Icon name={KIND_ICON[kind]} size={15} color={tone('$accent')} style={{ marginTop: 2 }} />
            <YStack flex={1} gap={1}>
              <Text fontSize={14} fontWeight="700" color="$color">
                {KINDS[kind].label}
              </Text>
              <Text fontSize={12} color="$muted" lineHeight={17}>
                {KINDS[kind].says}
              </Text>
            </YStack>
          </XStack>
        </Pressable>
      ))}
      <Button alignSelf="flex-end" size="$2" chromeless color="$muted" onPress={() => setOpen(false)}>
        Cancel
      </Button>
    </YStack>
  );
}
