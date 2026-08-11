import { styled, Text, YStack, type GetProps } from 'tamagui';

const CardFrame = styled(YStack, {
  name: 'Card',
  backgroundColor: '$card',
  borderRadius: '$5',
  borderWidth: 1,
  borderColor: '$borderColor',
});

/**
 * `inset` is deliberately overridden. It is also a CSS style prop on YStack
 * (the top/right/bottom/left shorthand), typed as `Variable<any> & boolean`,
 * which is why a plain boolean would not assign. A Card never needs the CSS
 * meaning, so we take the name for the layout flag instead.
 */
export type CardProps = Omit<GetProps<typeof CardFrame>, 'inset'> & {
  /** Full-bleed: for cards holding rows that bring their own padding. */
  inset?: boolean;
};

/** The single surface primitive the app is built from. */
export function Card({ inset, ...props }: CardProps) {
  return (
    <CardFrame
      padding={inset ? 0 : '$4'}
      gap={inset ? 0 : '$3'}
      overflow={inset ? 'hidden' : undefined}
      {...props}
    />
  );
}

export const SectionLabel = styled(Text, {
  name: 'SectionLabel',
  color: '$muted',
  fontSize: 12,
  fontWeight: '700',
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  paddingHorizontal: '$1',
});
