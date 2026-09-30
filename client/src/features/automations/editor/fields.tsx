import { useEffect, useState, type ReactNode } from 'react';
import { Input, Text, XStack, YStack } from 'tamagui';

import { WEEKDAYS, type ValueType, type Value, type Weekday } from '@kraftverk/device-sdk';
import { haptic, Icon } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../looks';

/*
  The editor's fields: small, and each a value in, a value out. A block's
  form is made of them, so every block edits its values the same way.
*/

/** A field's name, above it. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <Text fontSize={12} fontWeight="700" color="$muted">
      {children}
    </Text>
  );
}

/** A choice among a few, as chips: the chosen one filled. A radio group, for a screen reader and a keyboard. */
export function Chips<T extends string | number | boolean>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T | null; onChange: (value: T) => void }) {
  return (
    <XStack gap="$1.5" flexWrap="wrap" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <XStack
            key={String(option.value)}
            role="radio"
            aria-checked={chosen}
            aria-label={option.label}
            tabIndex={0}
            cursor="pointer"
            paddingHorizontal="$2.5"
            paddingVertical={5}
            borderRadius={999}
            borderWidth={1}
            borderColor={chosen ? '$accent' : '$borderColor'}
            backgroundColor={chosen ? '$accent' : 'transparent'}
            focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
            onPress={() => (haptic(), onChange(option.value))}
            onKeyDown={
              ((event: { key: string; preventDefault: () => void }) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onChange(option.value);
              }) as never
            }
          >
            <Text fontSize={13} fontWeight={chosen ? '700' : '500'} color={chosen ? '$background' : '$color'}>
              {option.label}
            </Text>
          </XStack>
        );
      })}
    </XStack>
  );
}

/**
 * A number, typed — kept as text while it is typed, so "1." is not lost — and
 * given back as a number once it is one. Its unit beside it.
 */
export function NumberField({
  label,
  value,
  unit,
  onChange,
  width = 90,
  shown = String,
}: {
  label: string;
  value: number | null;
  unit?: string;
  onChange: (value: number | null) => void;
  width?: number;
  /** How the number reads when it is not being typed: "07" for an hour. */
  shown?: (value: number) => string;
}) {
  const [text, setText] = useState(value === null ? '' : shown(value));
  useEffect(() => {
    if (Number(text) !== value) setText(value === null ? '' : shown(value));
    // Only a value changed from outside is shown: what is being typed stays as typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <XStack alignItems="center" gap="$2">
      <Input
        size="$3"
        width={width}
        value={text}
        inputMode="decimal"
        aria-label={label}
        backgroundColor="$background"
        borderColor="$borderColor"
        onChangeText={(next) => {
          setText(next);
          const number = Number(next.replace(',', '.'));
          onChange(next.trim() === '' || !Number.isFinite(number) ? null : number);
        }}
      />
      {unit ? (
        <Text fontSize={13} color="$muted">
          {unit}
        </Text>
      ) : null}
    </XStack>
  );
}

/** Seconds, as a person gives them: seconds, or minutes — kept as seconds. */
export function SecondsField({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const [inMinutes, setInMinutes] = useState(value !== null && value >= 120 && value % 60 === 0);
  return (
    <XStack alignItems="center" gap="$2" flexWrap="wrap">
      <NumberField label={label} value={value === null ? null : inMinutes ? value / 60 : value} onChange={(next) => onChange(next === null ? null : Math.round(inMinutes ? next * 60 : next))} />
      <Chips
        label={`${label}: in`}
        options={[
          { value: false, label: 's' },
          { value: true, label: 'min' },
        ]}
        value={inMinutes}
        onChange={setInMinutes}
      />
    </XStack>
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
  if (type.type === 'enum') return <Chips label={label} options={type.options} value={typeof value === 'string' ? value : null} onChange={onChange} />;
  if (type.type === 'number') return <NumberField label={label} value={typeof value === 'number' ? value : null} unit={type.unit} onChange={onChange} />;
  return (
    <Input size="$3" value={typeof value === 'string' ? value : ''} aria-label={label} backgroundColor="$background" borderColor="$borderColor" onChangeText={onChange} />
  );
}

const DAY_LABELS: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** Which days: every day, weekdays, weekends — or the days themselves, each on or off. None given is every day. */
export function DaysField({ value, onChange }: { value: readonly Weekday[] | undefined; onChange: (days: readonly Weekday[] | undefined) => void }) {
  const chosen = new Set(value ?? WEEKDAYS);
  const toggle = (day: Weekday) => {
    const next = WEEKDAYS.filter((one) => (one === day ? !chosen.has(one) : chosen.has(one)));
    // Not one day: it would never run — the last is kept.
    if (!next.length) return;
    onChange(next.length === 7 ? undefined : next);
  };
  return (
    <YStack gap="$2">
      <Chips
        label="Which days"
        options={[
          { value: 'every', label: 'Every day' },
          { value: 'weekdays', label: 'Weekdays' },
          { value: 'weekends', label: 'Weekends' },
        ]}
        value={chosen.size === 7 ? 'every' : [...chosen].join() === 'mon,tue,wed,thu,fri' ? 'weekdays' : [...chosen].join() === 'sat,sun' ? 'weekends' : null}
        onChange={(which) => onChange(which === 'every' ? undefined : which === 'weekdays' ? ['mon', 'tue', 'wed', 'thu', 'fri'] : ['sat', 'sun'])}
      />
      <XStack gap="$1.5" flexWrap="wrap" role="group" aria-label="Days of the week">
        {WEEKDAYS.map((day) => (
          <Pressable key={day} onPress={() => toggle(day)} label={`${DAY_LABELS[day]}: ${chosen.has(day) ? 'on' : 'off'}`}>
            <YStack
              width={40}
              paddingVertical={5}
              alignItems="center"
              borderRadius="$2"
              borderWidth={1}
              borderColor={chosen.has(day) ? '$accent' : '$borderColor'}
              backgroundColor={chosen.has(day) ? '$backgroundPress' : 'transparent'}
            >
              <Text fontSize={12} fontWeight={chosen.has(day) ? '700' : '500'} color={chosen.has(day) ? '$accent' : '$muted'}>
                {DAY_LABELS[day]}
              </Text>
            </YStack>
          </Pressable>
        ))}
      </XStack>
    </YStack>
  );
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

/** A time of day, "07:00": hours and minutes, typed. `label` tells two apart: "From: hour", "Until: hour". */
export function TimeField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const [hour = '07', minute = '00'] = value.split(':');
  const put = (h: number | null, m: number | null) => {
    const hh = Math.min(23, Math.max(0, h ?? 0));
    const mm = Math.min(59, Math.max(0, m ?? 0));
    onChange(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  };
  return (
    <XStack alignItems="center" gap="$1.5">
      <NumberField label={label ? `${label}: hour` : 'Hour'} value={Number(hour)} width={56} shown={twoDigits} onChange={(h) => put(h, Number(minute))} />
      <Text fontSize={16} fontWeight="700" color="$color">
        :
      </Text>
      <NumberField label={label ? `${label}: minute` : 'Minute'} value={Number(minute)} width={56} shown={twoDigits} onChange={(m) => put(Number(hour), m)} />
    </XStack>
  );
}

/**
 * One choice among many, shown as what is chosen: a tap opens the list
 * beneath, a pick closes it. For a part, a reading, a setting, an automation.
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
        <XStack alignItems="center" gap="$2" paddingHorizontal="$3" paddingVertical="$2" borderRadius="$3" borderWidth={1} borderColor={chosen ? '$borderColor' : '$warning'} backgroundColor="$background">
          <Text flex={1} fontSize={14} fontWeight={chosen ? '600' : '400'} color={chosen ? '$color' : '$warning'} numberOfLines={1}>
            {chosen ?? placeholder}
          </Text>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={tone('$muted')} />
        </XStack>
      </Pressable>
      {open ? (
        <YStack borderRadius="$3" borderWidth={1} borderColor="$borderColor" overflow="hidden">
          {options.length ? (
            options.map((option, index) => (
              <YStack key={option.key} borderTopWidth={index ? 1 : 0} borderColor="$borderColor">
                <Pressable selected={option.selected ?? false} onPress={() => (setOpen(false), onPick(option.value))}>
                  <YStack paddingHorizontal="$3" paddingVertical="$2" gap={1}>
                    <Text fontSize={14} color="$color">
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
            <Text padding="$3" fontSize={13} color="$muted">
              Nothing you have fits here.
            </Text>
          )}
        </YStack>
      ) : null}
    </YStack>
  );
}
