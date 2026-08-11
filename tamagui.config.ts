import { createTamagui } from 'tamagui';
import { tokens, themes } from '@tamagui/stacks';

export default createTamagui({
  tokens,
  themes,
  shorthands: {
    bg: ['backgroundColor'],
  },
});
