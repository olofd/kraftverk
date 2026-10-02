import { useTheme } from 'tamagui';

/** A colour of the theme, by its token: what a look is drawn in. */
export type Tone = '$success' | '$warning' | '$accent' | '$muted' | '$danger' | '$color' | '$background';

/** A theme colour by its token, for what takes a colour rather than a token: an icon. */
export function useTone(): (tone: Tone) => string | undefined {
  const theme = useTheme();
  return (tone) => (theme[tone.slice(1) as keyof typeof theme] as { val?: string } | undefined)?.val;
}
