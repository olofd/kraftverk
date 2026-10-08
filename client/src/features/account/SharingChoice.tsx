import { Text, YStack } from 'tamagui';

import type { SharingLevel } from '@kraftverk/api-client';
import { Chips } from '@kraftverk/ui';

/*
  What a person shares with the family of where they are
  (docs/PLAN-WORLD-MODEL.md §11.1), as the app asks it: in plain words, the
  place they are at first — never coordinates — and what each means said
  under it.
*/

const SHARING_OPTIONS: readonly { value: SharingLevel; label: string }[] = [
  { value: 'places', label: 'Which place I’m at' },
  { value: 'home-away', label: 'Only whether I’m home' },
  { value: 'precise', label: 'Where I am on the map' },
  { value: 'off', label: 'Nothing' },
];

/** What each choice means to the others, in a sentence. */
export const SHARING_MEANS: Record<SharingLevel, string> = {
  places: 'The family sees which home or zone you are at — "at work" — never where on the map.',
  'home-away': 'The family sees only whether you are at one of its homes.',
  precise: 'The family sees where you are on the map, and where you have been while it keeps that.',
  off: 'The family sees nothing of where you are, and no automation can use it.',
};

/** Another person's choice, said shortly: "shares which place they are at". */
export const SHARING_SHORT: Record<SharingLevel, string> = {
  places: 'shares which place they are at',
  'home-away': 'shares only whether they are home',
  precise: 'shares where they are on the map',
  off: 'shares nothing of where they are',
};

export function SharingChoice({ label, value, onChange }: { label: string; value: SharingLevel; onChange: (level: SharingLevel) => void }) {
  return (
    <YStack gap="$2">
      <Chips label={label} options={SHARING_OPTIONS} value={value} onChange={onChange} />
      <Text fontSize={12} color="$muted" lineHeight={17}>
        {SHARING_MEANS[value]}
      </Text>
    </YStack>
  );
}
