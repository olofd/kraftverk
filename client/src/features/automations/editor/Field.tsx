import { Input, Text, YStack } from 'tamagui';

import { fieldValue, withField, type Expr, type FieldSpec, type ListPath, type Weekday } from '@kraftverk/automation';
import { MAIN_PART, wholeTime } from '@kraftverk/device-sdk';
import { Chips } from '@kraftverk/ui';

import { Picker } from '../../../components/Picker';
import { blankCondition, ConditionField } from './Condition';
import { pickPart, useEditor } from './context';
import { GroupParts } from './GroupParts';
import { DaysField, DurationField, durationOf, Label, NumberField, TimeField, type Measure } from './fields';

/*
  One field of a construct — a trigger's, a step's — drawn by what it holds
  (the language's own description of it, @kraftverk/automation kinds/): a
  time, days, a length of time, how many times, a condition, a part, an event
  it reports. A kind's form is its fields, in their order; a kind with words
  of its own — a command, a setting, another automation started — draws them
  itself, and its steps within are drawn as its branches, not here.
*/

/** A construct's fields, each drawn by what it holds. */
/** `path`: where a step's fields are, within a sequence — inside a "for each", its parts are offered first. */
export function Fields<T extends object>({ fields, construct, set, path }: { fields: readonly FieldSpec[]; construct: T; set: (next: T) => void; path?: ListPath }) {
  return (
    <YStack gap="$2.5">
      {fields.map((field) => (
        <FieldEditor key={field.key} field={field} fields={fields} construct={construct} set={set} {...(path ? { path } : {})} />
      ))}
    </YStack>
  );
}

/** One field, by what it holds. */
function FieldEditor<T extends object>({ field, fields, construct, set, path }: { field: FieldSpec; fields: readonly FieldSpec[]; construct: T; set: (next: T) => void; path?: ListPath }) {
  const editor = useEditor();
  const value = fieldValue(construct, field);
  const put = (next: unknown) => set(withField(construct, field, next));
  const literal = (expr: unknown) => (expr && typeof expr === 'object' && 'value' in expr ? (expr as { value: unknown }).value : undefined);
  const help = field.help ? (
    <Text fontSize={12} color="$muted" lineHeight={17}>
      {field.help}
    </Text>
  ) : null;
  const type = field.type;
  switch (type.type) {
    case 'timeOfDay': {
      const time = literal(value);
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <TimeField label={field.label} value={typeof time === 'string' ? time : '07:00'} onChange={(at) => put({ value: at })} />
          {help}
        </YStack>
      );
    }
    case 'days':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <DaysField value={value as readonly Weekday[] | undefined} onChange={(days) => put(days)} />
        </YStack>
      );
    case 'duration': {
      // At least its shortest, when it must have one: in the largest unit that says it whole.
      const least: Measure = wholeTime(type.min);
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <DurationField
            label={field.label}
            value={durationOf(value as Expr | undefined) ?? (field.required ? least : null)}
            max={type.max}
            onChange={(next) => put(next === null || (next.value === 0 && !field.required) ? (field.required ? least : undefined) : next)}
          />
          {help}
        </YStack>
      );
    }
    case 'count':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <NumberField label={field.label} value={((n) => (typeof n === 'number' ? n : null))(literal(value))} onChange={(next) => put({ value: next })} />
          {help}
        </YStack>
      );
    case 'condition':
      return (
        <YStack gap="$1.5">
          <Label>{field.label}</Label>
          <ConditionField label={field.label} expr={(value as Expr | undefined) ?? blankCondition(null)} onChange={(next: Expr) => put(next)} />
        </YStack>
      );
    case 'role': {
      // A part that declares events, where this kind asks for one of them.
      const forEvents = fields.some((each) => each.type.type === 'event' && each.type.role === field.key);
      const role = String(value ?? '');
      const options = editor.parts((description, part) => !forEvents || (description.events ?? []).some((event) => (event.part ?? MAIN_PART) === part), path);
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Picker
            label={field.label}
            chosen={editor.chosen(role) ? editor.name(role) : null}
            placeholder="Choose a part"
            options={options.map((option) => ({ key: option.key, title: option.title, subtitle: option.subtitle, value: option, selected: option.role === role }))}
            onPick={(option) => {
              const picked = pickPart(editor.draft, option);
              editor.change(() => picked.draft);
              // A new part: what it reports is chosen afresh.
              const events = fields.filter((each) => each.type.type === 'event' && each.type.role === field.key);
              set(events.reduce<T>((next, each) => withField(next, each, ''), withField(construct, field, picked.role)));
            }}
          />
        </YStack>
      );
    }
    case 'event': {
      const from = fields.find((each) => each.key === type.role);
      const bound = from ? editor.partOf(String(fieldValue(construct, from) ?? '')) : null;
      if (!bound) return null;
      const events = (bound.description.events ?? []).filter((event) => (event.part ?? MAIN_PART) === bound.part);
      const chosen = String(value ?? '');
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          {events.length <= 3 ? (
            <Chips label={field.label} options={events.map((event) => ({ value: event.id, label: event.label }))} value={chosen || null} onChange={(event) => put(event)} />
          ) : (
            <Picker
              label={field.label}
              chosen={events.find((event) => event.id === chosen)?.label ?? null}
              placeholder="Choose what it reports"
              options={events.map((event) => ({ key: event.id, title: event.label, value: event.id, selected: event.id === chosen }))}
              onPick={(event) => put(event)}
            />
          )}
        </YStack>
      );
    }
    case 'group':
      // The parts it goes through: chosen here, the group made with the first.
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <GroupParts role={typeof value === 'string' && value ? value : null} label={field.label} onRole={(role) => put(role)} />
        </YStack>
      );
    case 'each':
      // What its steps call each part: a name of its own.
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Input size="$4" value={typeof value === 'string' ? value : ''} aria-label={field.label} autoCapitalize="none" autoCorrect={false} backgroundColor="$background" borderColor="$borderColor" onChangeText={(text) => put(text.trim())} />
          {help}
        </YStack>
      );
    case 'text':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Input size="$4" value={typeof value === 'string' ? value : ''} aria-label={field.label} backgroundColor="$background" borderColor="$borderColor" onChangeText={(text) => put(text)} />
          {help}
        </YStack>
      );
    case 'flag':
      // Not written is no: none is said rather than false.
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Chips
            label={field.label}
            options={[
              { value: false, label: 'No' },
              { value: true, label: 'Yes' },
            ]}
            value={value === true}
            onChange={(next) => put(next ? true : undefined)}
          />
          {help}
        </YStack>
      );
    // Drawn by the kind that has them — a command's, a setting's, an automation started — or as its branches.
    case 'value':
    case 'automation':
    case 'name':
    case 'memory':
    case 'args':
    case 'steps':
    // A trigger's id: given when a condition asks which trigger started it (`triggerIdOf`), not typed.
    case 'id':
      return null;
    default: {
      const unknown: never = type;
      throw new Error(`No field drawn for ${JSON.stringify(unknown)}`);
    }
  }
}
