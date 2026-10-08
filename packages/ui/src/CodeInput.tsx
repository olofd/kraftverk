import { useState } from 'react';
import { Input, Text, XStack, YStack } from 'tamagui';

/**
 * A one-time code: a box for each digit, drawn over one real field that
 * takes it all — typing, a paste ("123 456" too), and the phone's own
 * suggestion of the code it was just sent (`one-time-code`). So however the
 * code arrives, every box fills; only its digits are kept.
 */
export function CodeInput({
  length,
  value,
  onChange,
  disabled,
  label,
}: {
  length: number;
  value: string;
  onChange: (digits: string) => void;
  disabled?: boolean;
  /** What a screen reader says the field is. */
  label: string;
}) {
  const digits = value.replace(/\D/g, '').slice(0, length);
  const [focused, setFocused] = useState(false);
  // The box the next digit goes in: lit while the field has the focus.
  const at = Math.min(digits.length, length - 1);

  return (
    <YStack position="relative" width="100%" maxWidth={length * 56}>
      <XStack gap="$2" aria-hidden>
        {Array.from({ length }, (_, index) => (
          <YStack
            key={index}
            flex={1}
            height={52}
            maxWidth={48}
            borderRadius="$3"
            borderWidth={focused && index === at ? 2 : 1}
            borderColor={focused && index === at ? '$accent' : '$borderColor'}
            backgroundColor="$backgroundPress"
            alignItems="center"
            justifyContent="center"
            opacity={disabled ? 0.45 : 1}
          >
            <Text fontSize={22} fontWeight="700" color="$color">
              {digits[index] ?? ''}
            </Text>
          </YStack>
        ))}
      </XStack>
      {/* The field itself, unseen over the boxes: a tap anywhere on them is a tap on it. */}
      <Input
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        height="100%"
        opacity={0}
        borderWidth={0}
        aria-label={label}
        disabled={disabled}
        value={digits}
        inputMode="numeric"
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // No maxLength: a pasted "123 456" is longer than its digits, and is cut only once they are read.
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, length))}
      />
    </YStack>
  );
}
