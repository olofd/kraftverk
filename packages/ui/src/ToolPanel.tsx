import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import type { ConfigValues, ToolSpec } from '@kraftverk/device-sdk';

import { Card } from './Card.tsx';
import { haptic } from './haptics.ts';
import { SchemaForm, isComplete } from './SchemaForm.tsx';

/**
 * One of a device type's tools, drawn from its declaration: what it is, a form
 * for what it asks, a run button, and the answer. A tool that changes the
 * device says so before it is run. Whoever holds the device checks the input
 * and the answer against the same declaration; this only draws it.
 */
export function ToolPanel({
  tool,
  run,
  disabled,
  why,
}: {
  tool: ToolSpec & { name: string };
  /** Runs it — and, for a tool that says what it cannot undo, asks a person first: the app's actions do. */
  run: (input: ConfigValues) => Promise<unknown>;
  /** It cannot be run now: the device is not answering, or writes are off. */
  disabled?: boolean;
  /** Why, when it cannot. */
  why?: string;
}) {
  const [input, setInput] = useState<ConfigValues>(() =>
    Object.fromEntries(Object.entries(tool.input?.fields ?? {}).flatMap(([name, field]) => ('default' in field && field.default !== undefined ? [[name, field.default]] : [])))
  );
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ ok: true; value: unknown } | { ok: false; problem: string } | null>(null);
  const hasInput = Object.keys(tool.input?.fields ?? {}).length > 0;
  const ready = !tool.input || isComplete(tool.input, input);

  const go = async () => {
    haptic();
    setBusy(true);
    setAnswer(null);
    try {
      setAnswer({ ok: true, value: await run(input) });
    } catch (error) {
      setAnswer({ ok: false, problem: (error as Error).message || 'It could not be run' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card gap="$3">
      <YStack gap="$1">
        <XStack alignItems="center" gap="$2">
          <Text fontSize={15} fontWeight="700" color="$color" flex={1}>
            {tool.label}
          </Text>
          {tool.writes ? (
            <Text fontSize={11} fontWeight="700" color="$warning" borderColor="$warning" borderWidth={1} borderRadius="$2" paddingHorizontal="$1.5" paddingVertical={1}>
              CHANGES THE DEVICE
            </Text>
          ) : null}
        </XStack>
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {tool.description}
        </Text>
      </YStack>
      {hasInput ? <SchemaForm schema={tool.input!} values={input} disabled={busy || disabled} onChange={(name, value) => setInput((current) => ({ ...current, [name]: value }) as ConfigValues)} /> : null}
      <XStack alignItems="center" gap="$3">
        <Button size="$3" backgroundColor="$accent" color="$background" disabled={busy || disabled || !ready} opacity={busy || disabled || !ready ? 0.6 : 1} onPress={() => void go()}>
          {busy ? 'Running…' : 'Run'}
        </Button>
        {disabled && why ? (
          <Text fontSize={12} color="$muted" flex={1}>
            {why}
          </Text>
        ) : null}
      </XStack>
      {answer ? (
        answer.ok ? (
          <Text fontSize={12} fontFamily="$mono" color="$color" userSelect="text" backgroundColor="$backgroundPress" padding="$3" borderRadius="$3">
            {JSON.stringify(answer.value, null, 2)}
          </Text>
        ) : (
          <Text fontSize={12} color="$danger" lineHeight={18} role="alert">
            {answer.problem}
          </Text>
        )
      ) : null}
    </Card>
  );
}
