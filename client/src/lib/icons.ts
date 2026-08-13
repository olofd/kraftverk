import type { ComponentProps } from 'react';
import { Feather } from '@expo/vector-icons';

/**
 * Icon names arrive as strings from things the app did not write.
 *
 * A device package or a plugin declares `icon: 'zap'`, and by the time the app
 * sees it, it is a string from a manifest. Casting it to a Feather name is a
 * promise nobody checked; a plugin with a typo would render a blank space with
 * no clue why. So it is looked up instead, and anything unrecognised falls back
 * to a generic glyph rather than to nothing.
 */

export type FeatherName = ComponentProps<typeof Feather>['name'];

const KNOWN = Feather.glyphMap as Record<string, unknown>;

export function featherName(name: string | undefined, fallback: FeatherName = 'box'): FeatherName {
  return name && name in KNOWN ? (name as FeatherName) : fallback;
}
