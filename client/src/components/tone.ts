import { useTheme } from 'tamagui';

/**
 * How automations and their runs look (docs/SEQUENCES.md): each outcome its
 * own icon and colour, each kind of step its own icon, and time said the way a
 * person reads it. One place, so a card, a device's page and a timeline agree.
 */

export type Tone = '$success' | '$warning' | '$accent' | '$muted' | '$danger' | '$color' | '$background';

/** A theme colour by its token, for what takes a colour rather than a token: an icon. */
export function useTone(): (tone: Tone) => string | undefined {
  const theme = useTheme();
  return (tone) => (theme[tone.slice(1) as keyof typeof theme] as { val?: string } | undefined)?.val;
}
