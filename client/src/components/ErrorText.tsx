import type { ReactNode } from 'react';
import { Text, type TextProps } from 'tamagui';

/** A problem, said where it happened: in the danger colour, and to a screen reader as it appears. Nothing when there is none. */
export function ErrorText({ children, ...props }: { children: ReactNode } & Omit<TextProps, 'children'>) {
  if (children === null || children === undefined || children === false || children === '') return null;
  return (
    <Text fontSize={13} color="$danger" lineHeight={19} role="alert" {...props}>
      {children}
    </Text>
  );
}
