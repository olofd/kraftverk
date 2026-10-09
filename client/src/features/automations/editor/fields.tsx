import { useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Input, Text, XStack, YStack } from 'tamagui';

import { dateSpanOf, MONTHS, secondsText, WEEKDAYS, type Expr, type Month, type Weekday } from '@kraftverk/automation';
import { convert, unitsOfQuantity, UNITS, unitsLike, type Unit, type Value, type ValueType } from '@kraftverk/device-sdk';
import { Chips, haptic, useNumberText, useRadioGroup, useToggleGroup } from '@kraftverk/ui';

import { Picker } from '../../../components/Picker';

/*
  The editor's fields: small, and each a value in, a value out — one control
  for one value. A block's form is made of them, so every block edits its
  values the same way. Every one fits a phone: what does not fit on a line
  wraps, and nothing is under 40 px to touch.
*/

/** A field's name, above it. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <Text fontSize={13} fontWeight="600" color="$muted">
      {children}
    </Text>
  );
}

/** A number, typed, of no unit — one with a unit is a `MeasureField`. */
export function NumberField({ label, value, onChange, width = 96 }: { label: string; value: number | null; onChange: (value: number | null) => void; width?: number }) {
  const { text, setText, parse } = useNumberText(value);
  return (
    <XStack alignItems="center" gap="$2">
      <Input
        size="$4"
        width={width}
        value={text}
        inputMode="decimal"
        aria-label={label}
        backgroundColor="$background"
        borderColor="$borderColor"
        onChangeText={(next) => (setText(next), onChange(parse(next)))}
      />
    </XStack>
  );
}

/** A number as a rule keeps it beside its unit: what a field with a unit edits. */
export type Measure = { value: number; unit: Unit };

/** A number and its unit from a rule's value, when it is written outright in one of these units; null otherwise. */
const measureOf = (expr: Expr | undefined, units: readonly Unit[]): Measure | null =>
  expr && 'value' in expr && typeof expr.value === 'number' && expr.unit && units.includes(expr.unit) ? { value: expr.value, unit: expr.unit } : null;

/** The units of time a length of time is written in. */
const TIME_UNITS = unitsOfQuantity('duration');

/** Those offered side by side — a phone's width — with days only for a length already written in days. */
const timeUnitsFor = (value: Measure | null): readonly Unit[] => (value?.unit === 'd' ? TIME_UNITS : TIME_UNITS.filter((unit) => unit !== 'd'));

/** A length of time from a rule's value — its number and unit — or null for one that is not written outright. */
export const durationOf = (expr: Expr | undefined): Measure | null => measureOf(expr, TIME_UNITS);

/**
 * A number and its unit, as one control: the number typed, the unit chosen —
 * never typed — from those that measure what it measures (units.ts): a few
 * side by side, more from a list. The number stays as typed; what it means
 * changes with its unit. `max`: the most it may be, said under it before it
 * is reached, not after.
 */
function MeasureField({ label, value, units, max, onChange }: { label: string; value: Measure | null; units: readonly Unit[]; max?: Measure; onChange: (value: Measure | null) => void }) {
  const [unit, setUnit] = useState<Unit>(value?.unit ?? units[0]!);
  const { text, setText, parse } = useNumberText(value?.value ?? null);
  const written = (number: number | null, as: Unit): Measure | null => (number === null ? null : { value: number, unit: as });
  const over = value !== null && max !== undefined && (convert(value.value, value.unit, max.unit) ?? 0) > max.value;
  const measureIn = (each: Unit) => (haptic(), setUnit(each), onChange(written(parse(text), each)));
  const radio = useRadioGroup(units.length, units.indexOf(unit), (index) => measureIn(units[index]!));
  const number = (
    <Input
      unstyled
      width={72}
      paddingHorizontal="$3"
      fontSize={16}
      color="$color"
      value={text}
      inputMode="decimal"
      aria-label={label}
      onChangeText={(next) => (setText(next), onChange(written(parse(next), unit)))}
    />
  );
  return (
    <YStack gap="$1.5">
      {units.length > 4 ? (
        // More than fit beside it: chosen from a list.
        <XStack alignItems="center" gap="$2" flexWrap="wrap">
          <XStack height={44} borderWidth={1} borderColor={over ? '$warning' : '$borderColor'} borderRadius="$4" backgroundColor="$background" overflow="hidden">
            {number}
          </XStack>
          <Picker
            label={`${label}: in`}
            chosen={unit}
            placeholder="Unit"
            options={units.map((each) => ({ key: each, title: each, subtitle: UNITS[each].label, value: each, selected: each === unit }))}
            onPick={measureIn}
          />
        </XStack>
      ) : (
        <XStack alignSelf="flex-start" alignItems="stretch" height={44} borderWidth={1} borderColor={over ? '$warning' : '$borderColor'} borderRadius="$4" backgroundColor="$background" overflow="hidden">
          {number}
          <XStack role="radiogroup" aria-label={`${label}: in`} borderLeftWidth={1} borderColor="$borderColor">
            {units.map((each, index) => {
              const chosen = each === unit;
              return (
                <XStack
                  key={each}
                  role="radio"
                  aria-checked={chosen}
                  aria-label={UNITS[each].label}
                  {...radio(index)}
                  cursor="pointer"
                  minWidth={48}
                  paddingHorizontal="$3"
                  alignItems="center"
                  justifyContent="center"
                  backgroundColor={chosen ? '$accent' : 'transparent'}
                  focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
                  onPress={() => measureIn(each)}
                >
                  <Text fontSize={14} fontWeight={chosen ? '700' : '500'} color={chosen ? '$background' : '$color'}>
                    {each}
                  </Text>
                </XStack>
              );
            })}
          </XStack>
        </XStack>
      )}
      {max !== undefined ? (
        <Text fontSize={12} color={over ? '$warning' : '$muted'}>
          {UNITS[max.unit].dimension === 'time' ? `Longest: ${secondsText(convert(max.value, max.unit, 's') ?? max.value)}` : `At most ${max.value} ${max.unit}`}
        </Text>
      ) : null}
    </YStack>
  );
}

/** How long, as one control: a number and its unit of time — "20 s", "5 min", "2 h" — and the most it may be, in seconds. */
export function DurationField({ label, value, max, onChange }: { label: string; value: Measure | null; max?: number; onChange: (value: Measure | null) => void }) {
  return <MeasureField label={label} value={value} units={timeUnitsFor(value)} {...(max !== undefined ? { max: { value: max, unit: 's' } } : {})} onChange={onChange} />;
}

/** A value as a rule writes it outright: a value, and the unit a number is written in. */
export type Literal = { value: Value; unit?: Unit };

/**
 * A value of a type: on/off, one of some options, a number — in a unit like
 * its type's, chosen from a list, when it has one — or text.
 */
export function ValueField({ label, type, literal, onChange: onLiteral }: { label: string; type: ValueType | null; literal: Literal | null; onChange: (literal: Literal) => void }) {
  const value = literal?.value ?? null;
  const onChange = (next: Value) => onLiteral({ value: next });
  if (!type || type.type === 'boolean') {
    const words = type?.type === 'boolean' ? type.words : undefined;
    return (
      <Chips
        label={label}
        options={[
          { value: true, label: words?.true ?? 'On' },
          { value: false, label: words?.false ?? 'Off' },
        ]}
        value={typeof value === 'boolean' ? value : null}
        onChange={onChange}
      />
    );
  }
  if (type.type === 'enum') {
    // Two or three: pills. More: a list to pick from.
    return type.options.length <= 3 ? (
      <Chips label={label} options={type.options} value={typeof value === 'string' ? value : null} onChange={onChange} />
    ) : (
      <Picker
        label={label}
        chosen={type.options.find((option) => option.value === value)?.label ?? null}
        placeholder="Choose"
        options={type.options.map((option) => ({ key: option.value, title: option.label, value: option.value, selected: option.value === value }))}
        onPick={onChange}
      />
    );
  }
  if (type.type === 'number') {
    if (!type.unit) return <NumberField label={label} value={typeof value === 'number' ? value : null} onChange={onChange} />;
    const units = unitsLike(type.unit);
    // A number written with no unit is in its type's.
    const measure = typeof value === 'number' ? { value, unit: literal?.unit && units.includes(literal.unit) ? literal.unit : type.unit } : null;
    return <MeasureField label={label} value={measure} units={units} onChange={(next) => onLiteral(next ?? { value: null })} />;
  }
  return <Input size="$4" value={typeof value === 'string' ? value : ''} aria-label={label} backgroundColor="$background" borderColor="$borderColor" onChangeText={onChange} />;
}

const DAY_NAMES: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/**
 * Which days: seven round toggles, across one line — every one on is every
 * day, and the sentence above says "on weekdays" when that is what they make.
 * None given is every day; the last one on stays on.
 */
export function DaysField({ value, onChange }: { value: readonly Weekday[] | undefined; onChange: (days: readonly Weekday[] | undefined) => void }) {
  const chosen = new Set(value ?? WEEKDAYS);
  const toggle = (day: Weekday) => {
    const next = WEEKDAYS.filter((one) => (one === day ? !chosen.has(one) : chosen.has(one)));
    // Not one day: it would never run — the last is kept.
    if (!next.length) return;
    onChange(next.length === 7 ? undefined : next);
  };
  // One Tab stop for the seven: the arrows move between them.
  const keys = useToggleGroup(WEEKDAYS.length, (index) => toggle(WEEKDAYS[index]!));
  return (
    <YStack>
      <XStack justifyContent="space-between" rowGap={6} flexWrap="wrap" role="group" aria-label="Days of the week">
        {WEEKDAYS.map((day, index) => {
          const on = chosen.has(day);
          return (
            <XStack
              key={day}
              role="checkbox"
              aria-checked={on}
              aria-label={DAY_NAMES[day]}
              {...keys(index)}
              cursor="pointer"
              width={40}
              height={40}
              borderRadius={20}
              alignItems="center"
              justifyContent="center"
              borderWidth={1}
              borderColor={on ? '$accent' : '$borderColor'}
              backgroundColor={on ? '$accent' : '$background'}
              focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
              onPress={() => (haptic(), toggle(day))}
            >
              <Text fontSize={14} fontWeight="700" color={on ? '$background' : '$muted'}>
                {DAY_NAMES[day].charAt(0)}
              </Text>
            </XStack>
          );
        })}
      </XStack>
    </YStack>
  );
}

const MONTH_NAMES: Record<Month, string> = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };

/**
 * Which months: twelve toggles, four to a line — three even rows, the
 * seasons down its columns. Every one on is every month.
 * None given is every month; the last one on stays on.
 */
export function MonthsField({ value, onChange }: { value: readonly Month[] | undefined; onChange: (months: readonly Month[] | undefined) => void }) {
  const chosen = new Set(value ?? MONTHS);
  const toggle = (month: Month) => {
    const next = MONTHS.filter((one) => (one === month ? !chosen.has(one) : chosen.has(one)));
    if (!next.length) return;
    onChange(next.length === 12 ? undefined : next);
  };
  const keys = useToggleGroup(MONTHS.length, (index) => toggle(MONTHS[index]!));
  return (
    <XStack flexWrap="wrap" gap={6} maxWidth={4 * 64 + 3 * 6} role="group" aria-label="Months of the year">
      {MONTHS.map((month, index) => {
        const on = chosen.has(month);
        return (
          <XStack
            key={month}
            role="checkbox"
            aria-checked={on}
            aria-label={MONTH_NAMES[month]}
            {...keys(index)}
            cursor="pointer"
            width={64}
            height={40}
            borderRadius={20}
            alignItems="center"
            justifyContent="center"
            borderWidth={1}
            borderColor={on ? '$accent' : '$borderColor'}
            backgroundColor={on ? '$accent' : '$background'}
            focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
            onPress={() => (haptic(), toggle(month))}
          >
            <Text fontSize={13} fontWeight="700" color={on ? '$background' : '$muted'}>
              {MONTH_NAMES[month].slice(0, 3)}
            </Text>
          </XStack>
        );
      })}
    </XStack>
  );
}

/**
 * Which dates of the year, typed: "12-24", "12-01..12-24", by commas —
 * kept as typed until each reads as one; none, every date.
 */
export function DatesField({ label, value, onChange }: { label: string; value: readonly string[] | undefined; onChange: (dates: readonly string[] | undefined) => void }) {
  const [text, setText] = useState((value ?? []).join(', '));
  const dates = text
    .split(',')
    .map((each) => each.trim())
    .filter(Boolean);
  const wrong = dates.find((each) => !dateSpanOf(each));
  return (
    <YStack gap="$1">
      <Input
        size="$4"
        value={text}
        aria-label={label}
        placeholder="Every date"
        backgroundColor="$background"
        borderColor={wrong ? '$danger' : '$borderColor'}
        onChangeText={(next) => {
          setText(next);
          const typed = next
            .split(',')
            .map((each) => each.trim())
            .filter(Boolean);
          if (typed.every((each) => dateSpanOf(each))) onChange(typed.length ? typed : undefined);
        }}
      />
      {wrong ? (
        <Text fontSize={12} color="$danger">
          “{wrong}” is not a date of the year: month and day, 12-24 — or a span, 12-01..12-24
        </Text>
      ) : null}
    </YStack>
  );
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

/**
 * A time of day, "07:00": the browser's own time field on the web — a clock
 * to pick from — and hours and minutes typed on a phone. \`label\` names it:
 * "At", "From", "Until".
 */
export function TimeField({ value, onChange, label = 'Time' }: { value: string; onChange: (value: string) => void; label?: string }) {
  const [hour = '07', minute = '00'] = value.split(':');
  const put = (h: number | null, m: number | null) => onChange(`${twoDigits(Math.min(23, Math.max(0, h ?? 0)))}:${twoDigits(Math.min(59, Math.max(0, m ?? 0)))}`);
  if (Platform.OS === 'web') {
    return (
      <Input
        size="$4"
        width={140}
        // The browser's own: its clock, its keyboard, its way of reading a time aloud.
        type={'time' as never}
        value={value}
        aria-label={label}
        backgroundColor="$background"
        borderColor="$borderColor"
        onChangeText={(next) => (/^\d\d:\d\d$/.test(next) ? onChange(next) : undefined)}
      />
    );
  }
  return (
    <XStack alignItems="center" gap="$1.5">
      <NumberField label={`${label}: hour`} value={Number(hour)} width={64} onChange={(h) => put(h, Number(minute))} />
      <Text fontSize={18} fontWeight="700" color="$color">
        :
      </Text>
      <NumberField label={`${label}: minute`} value={Number(minute)} width={64} onChange={(m) => put(Number(hour), m)} />
    </XStack>
  );
}
