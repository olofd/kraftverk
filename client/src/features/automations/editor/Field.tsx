import { Input, Text, YStack } from 'tamagui';

import { fieldValue, OWN_HOME, withField, type Expr, type FieldSpec, type ListPath, type Month, type Weekday } from '@kraftverk/automation';
import { MAIN_PART, wholeTime } from '@kraftverk/device-sdk';
import { Chips } from '@kraftverk/ui';

import { Picker } from '../../../components/Picker';
import { blankCondition, ConditionField } from './Condition';
import { pickPart, useEditor } from './context';
import { GroupParts } from './GroupParts';
import { DatesField, DaysField, DurationField, durationOf, Label, MonthsField, NumberField, TimeField, type Measure } from './fields';
import { placeChoices, whoChoices, type WorldChoice } from '@kraftverk/api-client';

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
    case 'timeOfDay':
      return (
        <YStack gap="$1.5">
          <Label>{field.label}</Label>
          <TimeOfDayField label={field.label} expr={(value as Expr | undefined) ?? { value: '07:00' }} onChange={put} />
          {help}
        </YStack>
      );
    case 'days':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <DaysField value={value as readonly Weekday[] | undefined} onChange={(days) => put(days)} />
        </YStack>
      );
    case 'months':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <MonthsField value={value as readonly Month[] | undefined} onChange={(months) => put(months)} />
          {help}
        </YStack>
      );
    case 'dates':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <DatesField label={field.label} value={value as readonly string[] | undefined} onChange={(dates) => put(dates)} />
          {help}
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
    case 'who':
    case 'crowd':
    case 'place': {
      // Who or where: a word for the whole family, a role the draft has, or one of the family's, made a role as it is picked.
      const current = typeof value === 'string' ? value : '';
      const choices: WorldChoice[] =
        type.type === 'place' ? placeChoices(editor.world, editor.draft, editor.name, { ...(type.kinds ? { kinds: type.kinds } : {}), homeId: editor.homeId }) : whoChoices(editor.world, editor.draft, editor.name, { ...(type.type === 'who' && type.anyone ? { anyone: type.anyone } : {}), crowd: type.type === 'crowd' });
      const chosen = choices.find((choice) => choice.key === current || choice.key === `role:${current}`);
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Picker
            label={field.label}
            chosen={chosen ? chosen.title : current ? editor.name(current) : null}
            placeholder={type.type === 'place' ? 'Choose where' : 'Choose who'}
            options={choices.map((choice) => ({ key: choice.key, title: choice.title, ...(choice.subtitle ? { subtitle: choice.subtitle } : {}), value: choice, selected: choice === chosen }))}
            onPick={(choice) => {
              const picked = choice.pick(editor.draft);
              editor.change((draft) => ({ ...draft, ...picked.draft, name: draft.name }));
              put(picked.value);
            }}
          />
          {help}
        </YStack>
      );
    }
    case 'mode': {
      const modes = editor.world.modes;
      const chosen = typeof value === 'string' ? value : null;
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Chips label={field.label} options={modes.map((mode) => ({ value: mode.key, label: mode.name }))} value={chosen} onChange={(mode) => put(mode)} />
          {help}
        </YStack>
      );
    }
    case 'choice':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Chips label={field.label} options={type.options} value={typeof value === 'string' ? value : null} onChange={(next) => put(next)} />
          {help}
        </YStack>
      );
    case 'message':
      return (
        <YStack gap="$1">
          <Label>{field.label}</Label>
          <Input
            size="$4"
            value={typeof value === 'string' ? value : ''}
            aria-label={field.label}
            maxLength={type.max}
            multiline={type.max > 200}
            backgroundColor="$background"
            borderColor="$borderColor"
            onChangeText={(text) => put(text === '' && !field.required ? undefined : text)}
          />
          {help}
        </YStack>
      );
    // Drawn by the kind that has them — a command's, a setting's, an automation started — or as its branches.
    case 'value':
    case 'automation':
    case 'script':
    case 'name':
    case 'memory':
    case 'variable':
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

type TimeSource = 'time' | 'sun' | 'variable';

/**
 * A time of day, from where it comes: a time on the clock, the sun where
 * the home is — so long before or after it — or one of the home's time
 * variables, "Wake at". One it cannot draw — a reading's — is said in words,
 * and replaced only when asked.
 */
function TimeOfDayField({ label, expr, onChange }: { label: string; expr: Expr; onChange: (expr: Expr) => void }) {
  const editor = useEditor();
  const times = editor.variablesAt(OWN_HOME).filter((variable) => variable.kind === 'time');
  const source: TimeSource | null = 'value' in expr ? 'time' : 'sun' in expr ? 'sun' : 'variable' in expr ? 'variable' : null;
  const sources: { value: TimeSource; label: string }[] = [
    { value: 'time', label: 'A time' },
    { value: 'sun', label: 'The sun' },
    ...(times.length || source === 'variable' ? [{ value: 'variable' as const, label: 'A variable' }] : []),
  ];
  const start = (next: TimeSource): Expr => (next === 'time' ? { value: '07:00' } : next === 'sun' ? { sun: 'sunset' } : { variable: { key: times[0]?.key ?? '', at: OWN_HOME } });
  if (source === null)
    return (
      <YStack gap="$1.5">
        <Text fontSize={15} color="$color" lineHeight={21}>
          {editor.saidExpr(expr)}
        </Text>
        <Chips label={`${label}: from where`} options={sources} value={null} onChange={(next) => onChange(start(next))} />
      </YStack>
    );
  return (
    <YStack gap="$2">
      <Chips label={`${label}: from where`} options={sources} value={source} onChange={(next) => (next === source ? undefined : onChange(start(next)))} />
      {'value' in expr ? <TimeField label={label} value={typeof expr.value === 'string' ? expr.value : '07:00'} onChange={(at) => onChange({ value: at })} /> : null}
      {'sun' in expr ? <SunTime label={label} expr={expr} onChange={onChange} /> : null}
      {'variable' in expr ? (
        <Picker
          label={`${label}: which variable`}
          chosen={times.find((variable) => variable.key === expr.variable.key)?.field.title ?? (expr.variable.key || null)}
          placeholder="Choose a time variable"
          options={times.map((variable) => ({ key: variable.key, title: variable.field.title, value: variable.key, selected: variable.key === expr.variable.key }))}
          onPick={(key) => onChange({ variable: { key, at: expr.variable.at } })}
        />
      ) : null}
    </YStack>
  );
}

/** Sunrise or sunset where the home is — at it, or so long before or after. */
function SunTime({ label, expr, onChange }: { label: string; expr: Extract<Expr, { sun: unknown }>; onChange: (expr: Expr) => void }) {
  const when = !expr.offset ? 'at' : expr.offset.before ? 'before' : 'after';
  const by = expr.offset ? durationOf(expr.offset.by) : null;
  return (
    <YStack gap="$2">
      <Chips
        label={`${label}: which`}
        options={[
          { value: 'sunrise', label: 'Sunrise' },
          { value: 'sunset', label: 'Sunset' },
        ]}
        value={expr.sun}
        onChange={(sun) => onChange({ ...expr, sun })}
      />
      <Chips
        label={`${label}: when`}
        options={[
          { value: 'before', label: 'Before' },
          { value: 'at', label: 'At it' },
          { value: 'after', label: 'After' },
        ]}
        value={when}
        onChange={(next) => onChange(next === 'at' ? { sun: expr.sun } : { sun: expr.sun, offset: { by: expr.offset?.by ?? { value: 30, unit: 'min' }, before: next === 'before' } })}
      />
      {expr.offset ? (
        <DurationField label={`${label}: how long`} value={by ?? { value: 30, unit: 'min' }} max={6 * 3600} onChange={(next) => onChange({ sun: expr.sun, offset: { by: next ?? { value: 30, unit: 'min' }, before: expr.offset!.before } })} />
      ) : null}
    </YStack>
  );
}
