import { styled, Text, YStack } from 'tamagui';

/** The single surface primitive the whole app is built from. */
export const Card = styled(YStack, {
  name: 'Card',
  backgroundColor: '$card',
  borderRadius: '$5',
  borderWidth: 1,
  borderColor: '$borderColor',
  padding: '$4',
  gap: '$3',

  variants: {
    /** For cards that hold full-bleed rows, which bring their own padding. */
    inset: {
      true: { padding: 0, gap: 0, overflow: 'hidden' },
    },
    tinted: {
      true: { backgroundColor: '$backgroundStrong' },
    },
  } as const,
});

export const SectionLabel = styled(Text, {
  name: 'SectionLabel',
  color: '$muted',
  fontSize: 12,
  fontWeight: '700',
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  paddingHorizontal: '$1',
});
