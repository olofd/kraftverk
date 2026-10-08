import { YStack } from 'tamagui';

import { RowSeparator, ToggleRow } from './Row.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';

/**
 * Whether where a device has been is kept, and for how long
 * (docs/PLAN-MAPS.md): off until its owner turns it on, a day to a year.
 * Drawn the same in a device's settings and on its own screen; whoever draws
 * it asks before turning it off, which forgets what was kept.
 */

/** The lengths offered, in days. */
const LENGTHS = [
  { value: 1, label: '1 day' },
  { value: 7, label: '1 week' },
  { value: 30, label: '1 month' },
  { value: 90, label: '3 months' },
  { value: 366, label: '1 year' },
] as const;

/** "1 day", "30 days": how long, said. */
export const daysText = (days: number) => LENGTHS.find((length) => length.value === days)?.label ?? `${days} days`;

/** Kept for a month, when first turned on: enough to look back on a journey, and gone before it is forgotten that it was kept. */
const FIRST_DAYS = 30;

export function TrackSetting({ days, onChange, disabled }: { days: number | null; onChange: (days: number | null) => void; disabled?: boolean }) {
  // A length a file said that is not offered here is offered too, so it shows as chosen.
  const options = LENGTHS.some((length) => length.value === days) || days === null ? LENGTHS : [...LENGTHS, { value: days, label: daysText(days) }].sort((a, b) => a.value - b.value);
  return (
    <YStack>
      <ToggleRow
        title="Keep where it has been"
        subtitle={
          days === null
            ? 'Off: only where it is now is known. Turned on, its trail is kept in your home — never anywhere else, never in an export.'
            : `Its trail is kept ${daysText(days)} in your home, never anywhere else and never in an export. Turning it off forgets it.`
        }
        checked={days !== null}
        disabled={disabled}
        onCheckedChange={(on) => onChange(on ? FIRST_DAYS : null)}
      />
      {days !== null ? (
        <>
          <RowSeparator />
          <SegmentedControl title="For how long" value={days} options={options} disabled={disabled} onChange={(next) => onChange(next)} />
        </>
      ) : null}
    </YStack>
  );
}
