import { createElement } from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { useTheme, YStack } from 'tamagui';

import { haptic } from './haptics.ts';
import { Icon } from './Icon.tsx';

type Props = {
  on: boolean;
  /** What it switches, for a screen reader: "Power". */
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Asked for and not yet confirmed: drawn as asked, with a spinner, and locked. */
  pending?: boolean;
  size?: number;
};

/**
 * The one big control of a device that is mostly on or off — a plug. Round,
 * lit when on, a spinner while the device confirms.
 *
 * A switch to assistive technology, like `Toggle`: on the web a real
 * `<button role="switch">`, so Tab reaches it and Space and Enter press it.
 */
export function PowerButton({ on, label, onChange, disabled, pending, size = 76 }: Props) {
  const theme = useTheme();
  const locked = disabled || pending;
  const lit = theme.success?.val ?? '#16a34a';
  const dark = theme.backgroundPress?.val ?? '#1f2937';
  const press = () => {
    if (locked) return;
    haptic();
    onChange(!on);
  };

  const face = (
    <YStack
      width={size}
      height={size}
      borderRadius={size / 2}
      alignItems="center"
      justifyContent="center"
      backgroundColor={on ? lit : dark}
      borderWidth={on ? 0 : 1}
      borderColor="$borderColor"
      // A soft glow while on: lit, not just coloured.
      style={on ? ({ boxShadow: `0 0 ${size / 3}px ${lit}66` } as never) : undefined}
    >
      {pending ? (
        <ActivityIndicator color={on ? '#ffffff' : theme.muted?.val} />
      ) : (
        <Icon name="power" size={size * 0.4} color={on ? '#ffffff' : theme.muted?.val} />
      )}
    </YStack>
  );

  if (Platform.OS === 'web') {
    return createElement(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': label,
        'aria-busy': pending || undefined,
        disabled: locked,
        onClick: press,
        style: {
          padding: 0,
          margin: 0,
          border: 'none',
          borderRadius: size,
          background: 'transparent',
          opacity: disabled ? 0.5 : 1,
          cursor: locked ? 'default' : 'pointer',
          outlineOffset: 3,
          flexShrink: 0,
        },
      },
      face
    );
  }

  return (
    <YStack
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={locked}
      aria-busy={pending || undefined}
      opacity={disabled ? 0.5 : 1}
      pressStyle={locked ? undefined : { scale: 0.96 }}
      onPress={press}
    >
      {face}
    </YStack>
  );
}
