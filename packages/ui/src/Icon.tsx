import type { ComponentProps } from 'react';
import { Feather } from '@expo/vector-icons';

export type IconName = ComponentProps<typeof Feather>['name'];

/**
 * An icon beside words: seen, not read. Feather draws each one as a glyph of
 * an icon font, and a screen reader read that glyph into the name of whatever
 * held it: a button called " Reset". Every icon here stands next to words
 * that say the same; one that stands alone gets its name from what holds it
 * (`aria-label`), never from the glyph.
 */
export function Icon(props: ComponentProps<typeof Feather>) {
  return <Feather aria-hidden {...props} />;
}
