import { createAnimations } from '@tamagui/animations-react-native';
import { createInterFont } from '@tamagui/font-inter';
import { createTamagui, createTokens } from 'tamagui';
import { Platform } from 'react-native';

/**
 * The React Native driver works on react-native-web too, so one set of
 * animations covers iOS and web without a platform-split config file.
 */
const animations = createAnimations({
  fast: { type: 'spring', damping: 22, mass: 0.9, stiffness: 260 },
  medium: { type: 'spring', damping: 18, mass: 1, stiffness: 160 },
  slow: { type: 'spring', damping: 20, mass: 1.2, stiffness: 60 },
  bouncy: { type: 'spring', damping: 12, mass: 0.9, stiffness: 200 },
});

/**
 * Use the platform's system UI font rather than shipping an Inter binary.
 * `createInterFont` only supplies the size/lineHeight/weight scales — the
 * family is ours to pick, and picking a font we do not bundle would silently
 * fall back to an undefined face on iOS.
 */
const systemFamily = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  default: 'System',
});

const bodyFont = createInterFont({ family: systemFamily });

const headingFont = createInterFont({
  family: systemFamily,
  weight: { 6: '700', 7: '800', 9: '800' },
  letterSpacing: { 6: -0.5, 7: -1, 9: -1.5 },
});

const palette = {
  white: '#ffffff',
  black: '#08090c',

  slate1: '#f7f8fa',
  slate2: '#eef0f4',
  slate3: '#dfe3ea',
  slate4: '#c6ccd8',
  slate5: '#8b93a4',
  slate6: '#5b6274',
  slate7: '#333a4a',
  slate8: '#1e2430',
  slate9: '#151a23',
  slate10: '#0e121a',

  // Charge/energy accents
  green: '#22c55e',
  greenDark: '#16a34a',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
};

const tokens = createTokens({
  color: palette,
  /*
    Half steps are real tokens, not a convenience.

    Tamagui silently drops a style whose token does not exist, so `gap="$1.5"`
    was not "close enough to $1" — it was no gap at all, and `paddingHorizontal
    ="$2.5"` was no padding. That is how the history pills ended up touching
    each other with no space between them. Anything the code asks for has to be
    defined here or it vanishes without a warning.
  */
  space: {
    0: 0,
    0.5: 2,
    1: 4,
    1.5: 6,
    2: 8,
    2.5: 10,
    3: 12,
    3.5: 14,
    true: 16,
    4: 16,
    5: 24,
    6: 32,
    7: 40,
    8: 56,
    9: 72,
  },
  size: {
    0: 0,
    1: 20,
    2: 28,
    3: 36,
    true: 44,
    4: 44,
    5: 52,
    6: 64,
    7: 80,
    8: 104,
    9: 128,
  },
  radius: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    true: 16,
    4: 16,
    5: 20,
    6: 28,
    7: 36,
  },
  zIndex: {
    0: 0,
    1: 100,
    2: 200,
    3: 300,
    4: 400,
    5: 500,
  },
});

/**
 * Tamagui's built-in components (Button, Card, Input…) read a fixed set of
 * theme keys. Every one of them is defined here for both schemes so no
 * component renders against an undefined value.
 */
const light = {
  background: palette.slate1,
  backgroundHover: palette.slate2,
  backgroundPress: palette.slate3,
  backgroundFocus: palette.slate2,
  backgroundStrong: palette.white,
  backgroundTransparent: 'rgba(255,255,255,0)',
  // Tamagui's Switch/Checkbox read this for their "on" state.
  backgroundActive: palette.greenDark,

  color: palette.slate9,
  colorHover: palette.slate10,
  colorPress: palette.slate10,
  colorFocus: palette.slate9,
  colorTransparent: 'rgba(0,0,0,0)',

  borderColor: palette.slate3,
  borderColorHover: palette.slate4,
  borderColorPress: palette.slate4,
  borderColorFocus: palette.blue,

  placeholderColor: palette.slate5,
  outlineColor: palette.blue,

  shadowColor: 'rgba(15, 23, 42, 0.16)',
  shadowColorHover: 'rgba(15, 23, 42, 0.24)',
  shadowColorPress: 'rgba(15, 23, 42, 0.28)',
  shadowColorFocus: 'rgba(15, 23, 42, 0.24)',

  // App-specific keys used by the dashboard
  muted: palette.slate6,
  card: palette.white,
  accent: palette.greenDark,
  success: palette.greenDark,
  warning: palette.amber,
  danger: palette.red,
};

const dark: typeof light = {
  background: palette.slate10,
  backgroundHover: palette.slate9,
  backgroundPress: palette.slate8,
  backgroundFocus: palette.slate9,
  backgroundStrong: palette.slate9,
  backgroundTransparent: 'rgba(8,9,12,0)',
  backgroundActive: palette.green,

  color: palette.slate1,
  colorHover: palette.white,
  colorPress: palette.slate2,
  colorFocus: palette.white,
  colorTransparent: 'rgba(255,255,255,0)',

  borderColor: palette.slate8,
  borderColorHover: palette.slate7,
  borderColorPress: palette.slate7,
  borderColorFocus: palette.blue,

  placeholderColor: palette.slate6,
  outlineColor: palette.blue,

  shadowColor: 'rgba(0, 0, 0, 0.6)',
  shadowColorHover: 'rgba(0, 0, 0, 0.7)',
  shadowColorPress: 'rgba(0, 0, 0, 0.75)',
  shadowColorFocus: 'rgba(0, 0, 0, 0.7)',

  muted: palette.slate5,
  card: palette.slate9,
  accent: palette.green,
  success: palette.green,
  warning: palette.amber,
  danger: palette.red,
};

const config = createTamagui({
  animations,
  fonts: {
    body: bodyFont,
    heading: headingFont,
  },
  tokens,
  themes: { light, dark },
  shorthands: {
    bg: 'backgroundColor',
    br: 'borderRadius',
    f: 'flex',
    p: 'padding',
    px: 'paddingHorizontal',
    py: 'paddingVertical',
    m: 'margin',
    w: 'width',
    h: 'height',
    ai: 'alignItems',
    jc: 'justifyContent',
  } as const,
  media: {
    xs: { maxWidth: 660 },
    sm: { maxWidth: 800 },
    gtXs: { minWidth: 661 },
    gtSm: { minWidth: 801 },
    gtMd: { minWidth: 1020 },
  },
  settings: {
    defaultFont: 'body',
    // Emits `@media (prefers-color-scheme)` rules so web follows the OS theme.
    shouldAddPrefersColorThemes: true,
    // Expo web runs client-only here (no static rendering), so skip the
    // hydration-matching double render.
    disableSSR: true,
  },
});

/**
 * Raw background colours, for the places that need a plain string before the
 * Tamagui runtime is available (native root view, web `<meta theme-color>`).
 */
export const BACKGROUNDS = {
  light: light.background,
  dark: dark.background,
} as const;

export type AppConfig = typeof config;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}

export default config;
