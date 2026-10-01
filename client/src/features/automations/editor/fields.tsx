import { useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Input, Text, XStack, YStack } from 'tamagui';

import { secondsText, WEEKDAYS, type ValueType, type Value, type Weekday } from '@kraftverk/device-sdk';
import { Chips, haptic, Icon, useRadioGroup } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../looks';

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

/**
 * A number as it is typed — kept as text while it is typed, so "1." is not
 * lost — and given back as a number once it is one. `shown`: how it reads when
 * it is not being typed.
 */
function useNumberText(value: number | null, shown: (value: number) => string = String) {
  const [text, setText] = useState(value === null ? '' : shown(value));
  useEffect(() => {
    if (Number(text.replace(',', '.')) !== value) setText(value === null ? '' : shown(value));
    // Only a value changed from outside is shown: what is being typed stays as typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parse = (next: string): number | null => {
    const number = Number(next.replace(',', '.'));
    return next.trim() === '' || !Number.isFinite(number) ? null : number;
  };
  return { text, setText, parse };
}

/** A number, typed, its unit beside it. */
export function NumberField({ label, value, unit, onChange, width = 96 }: { label: string; value: number | null; unit?: string; onChange: (value: number | null) => void; width?: number }) {
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
      {unit ? (
        <Text fontSize={14} color="$muted">
          {unit}
        </Text>
      ) : null}
    </XStack>
  );
}

const UNITS = ['s', 'min'] as const;
type Unit = (typeof UNITS)[number];

/**
 * How long, as one control: the number and its unit together — "20 s",
 * "5 min" — kept as seconds, and the most it may be said under it before it
 * is reached, not after.
 */
export function DurationField({ label, value, max, onChange }: { label: string; value: number | null; max?: number; onChange: (value: number | null) => void }) {
  const [unit, setUnit] = useState<Unit>(value !== null && value >= 120 && value % 60 === 0 ? 'min' : 's');
  const inUnit = value === null ? null : unit === 'min' ? value / 60 : value;
  const { text, setText, parse } = useNumberText(inUnit);
  const toSeconds = (number: number | null, as: Unit) => (number === null ? null : Math.round(as === 'min' ? number * 60 : number));
  const over = value !== null && max !== undefined && value > max;
  // The number stays as typed; what it means changes with its unit.
  const measureIn = (each: Unit) => (haptic(), setUnit(each), onChange(toSeconds(parse(text), each)));
  const radio = useRadioGroup(UNITS.length, UNITS.indexOf(unit), (index) => measureIn(UNITS[index]!));
  return (
    <YStack gap="$1.5">
      <XStack alignSelf="flex-start" alignItems="stretch" height={44} borderWidth={1} borderColor={over ? '$warning' : '$borderColor'} borderRadius="$4" backgroundColor="$background" overflow="hidden">
        <Input
          unstyled
          width={72}
          paddingHorizontal="$3"
          fontSize={16}
          color="$color"
          value={text}
          inputMode="decimal"
          aria-label={label}
          onChangeText={(next) => (setText(next), onChange(toSeconds(parse(next), unit)))}
        />
        <XStack role="radiogroup" aria-label={`${label}: in`} borderLeftWidth={1} borderColor="$borderColor">
          {UNITS.map((each, index) => {
            const chosen = each === unit;
            return (
              <XStack
                key={each}
                role="radio"
                aria-checked={chosen}
                aria-label={each === 's' ? 'seconds' : 'minutes'}
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
      {max !== undefined ? (
        <Text fontSize={12} color={over ? '$warning' : '$muted'}>
          Longest: {secondsText(max)}
        </Text>
      ) : null}
    </YStack>
  );
}

/** A value of a type: on/off, one of some options, a number in its unit, or text. */
export function ValueField({ label, type, value, onChange }: { label: string; type: ValueType | null; value: Value; onChange: (value: Value) => void }) {
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
  if (type.type === 'number') return <NumberField label={label} value={typeof value === 'number' ? value : null} unit={type.unit} onChange={onChange} />;
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
  return (
    <YStack>
      <XStack justifyContent="space-between" rowGap={6} flexWrap="wrap" role="group" aria-label="Days of the week">
        {WEEKDAYS.map((day) => {
          const on = chosen.has(day);
          return (
            <XStack
              key={day}
              role="checkbox"
              aria-checked={on}
              aria-label={DAY_NAMES[day]}
              tabIndex={0}
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
              onKeyDown={
                ((event: { key: string; preventDefault: () => void }) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  toggle(day);
                }) as never
              }
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

/**
 * One choice among many, shown as what is chosen: a tap opens the list
 * beneath, a pick closes it. For a part, a reading, a setting, an automation,
 * a kind of condition, a comparison.
 */
export function Picker<T>({
  label,
  chosen,
  placeholder,
  options,
  onPick,
}: {
  label: string;
  chosen: string | null;
  placeholder: string;
  options: readonly { key: string; title: string; subtitle?: string; value: T; selected?: boolean }[];
  onPick: (value: T) => void;
}) {
  const tone = useTone();
  const [open, setOpen] = useState(false);
  return (
    <YStack gap="$1.5">
      <Pressable onPress={() => setOpen((was) => !was)} label={`${label}: ${chosen ?? placeholder}. ${open ? 'Close' : 'Choose'}`}>
        <XStack alignItems="center" gap="$2" paddingHorizontal="$3" minHeight={44} borderRadius="$4" borderWidth={1} borderColor={chosen ? '$borderColor' : '$warning'} backgroundColor="$background">
          <Text flex={1} fontSize={15} fontWeight={chosen ? '600' : '400'} color={chosen ? '$color' : '$warning'} numberOfLines={1}>
            {chosen ?? placeholder}
          </Text>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={tone('$muted')} />
        </XStack>
      </Pressable>
      {open ? (
        <YStack borderRadius="$4" borderWidth={1} borderColor="$borderColor" overflow="hidden" backgroundColor="$background">
          {options.length ? (
            options.map((option, index) => (
              <YStack key={option.key} borderTopWidth={index ? 1 : 0} borderColor="$borderColor">
                <Pressable selected={option.selected ?? false} onPress={() => (setOpen(false), onPick(option.value))}>
                  <YStack paddingHorizontal="$3" paddingVertical="$2.5" minHeight={44} justifyContent="center" gap={2}>
                    <Text fontSize={15} color="$color">
                      {option.title}
                    </Text>
                    {option.subtitle ? (
                      <Text fontSize={12} color="$muted">
                        {option.subtitle}
                      </Text>
                    ) : null}
                  </YStack>
                </Pressable>
              </YStack>
            ))
          ) : (
            <Text padding="$3" fontSize={14} color="$muted">
              Nothing you have fits here.
            </Text>
          )}
        </YStack>
      ) : null}
    </YStack>
  );
}
