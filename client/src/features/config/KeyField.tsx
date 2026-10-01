import { useEffect, useState } from 'react';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import { KEY } from '@kraftverk/config';
import { haptic } from '@kraftverk/ui';

/**
 * A key — the name a configuration file knows a device or an automation by
 * (docs/CONFIG.md) — changed in place: checked as it is typed, saved with a
 * button that appears only when there is something to save.
 */
export function KeyField({ value, label, help, onSave }: { value: string; label: string; help: string; onSave: (key: string) => Promise<void> }) {
  const [key, setKey] = useState(value);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setKey(value), [value]);
  const typed = key.trim();
  const valid = KEY.test(typed);
  const dirty = typed !== value;

  const save = async () => {
    if (!dirty || !valid || busy) return;
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await onSave(typed);
    } catch (err) {
      setProblem(describeError(err) || 'That key could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack padding="$4" gap="$2">
      <Text fontSize={15} fontWeight="600" color="$color">
        {label}
      </Text>
      <XStack gap="$2">
        <Input
          flex={1}
          size="$4"
          value={key}
          maxLength={63}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          fontFamily="$mono"
          onChangeText={(next) => (setKey(next), setProblem(null))}
          onSubmitEditing={() => void save()}
          backgroundColor="$background"
          borderColor={dirty && !valid ? '$warning' : '$borderColor'}
          aria-label={label}
        />
        {dirty ? (
          <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || !valid} opacity={busy || !valid ? 0.5 : 1} onPress={() => void save()}>
            Save
          </Button>
        ) : null}
      </XStack>
      <Text fontSize={12} color={problem || (dirty && !valid) ? '$warning' : '$muted'} lineHeight={17} role={problem ? 'alert' : undefined}>
        {problem ?? (dirty && !valid ? 'Lowercase letters, digits and dashes, starting with a letter or digit: “garage-station”.' : help)}
      </Text>
    </YStack>
  );
}
