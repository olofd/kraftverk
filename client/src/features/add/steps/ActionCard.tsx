import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import type { ConfigValues, SetupActionResult, SetupActionView, SetupChoice } from '@kraftverk/device-sdk';
import { describeError, type SetupFlow } from '@kraftverk/api-client';
import { Card, isComplete, Row, RowSeparator, SchemaForm } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { QrCode } from '../../../components/QrCode';
import { ErrorLine, PRIMARY } from './StepFrame';

/** A helper's candidates: which one is it? */
export function Choices({ result, picking, onPick }: { result: SetupActionResult; picking: string | null; onPick: (choice: SetupChoice) => void }) {
  return (
    <YStack gap="$2">
      <Text fontSize={13} color={result.ok ? '$color' : '$danger'} lineHeight={19} paddingHorizontal="$1">
        {result.detail}
      </Text>
      {result.choices?.length ? (
        <Card inset>
          {result.choices.map((choice, index) => (
            <YStack key={choice.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable selected={picking === choice.id} disabled={picking !== null} onPress={() => onPick(choice)}>
                <Row title={`${choice.label}${choice.recommended ? ' · likely this one' : ''}`} subtitle={choice.detail} />
              </Pressable>
            </YStack>
          ))}
        </Card>
      ) : null}
    </YStack>
  );
}

/**
 * A result that is waiting on a person: the QR code to scan, what to do, and
 * the same action asked again until it is done or the time runs out.
 */
function Waiting({ result, onAgain, onCancel }: { result: SetupActionResult; onAgain: (next: ConfigValues) => void; onCancel: () => void }) {
  const waiting = result.waiting!;
  const expired = Date.parse(waiting.until) <= Date.now();
  useEffect(() => {
    if (expired) return;
    const timer = setTimeout(() => onAgain(waiting.next), waiting.everyMs);
    return () => clearTimeout(timer);
  }, [expired, onAgain, waiting]);

  return (
    <Card gap="$4" alignItems="center" paddingVertical="$5">
      {waiting.qr && !expired ? (
        <YStack padding="$2" backgroundColor="#ffffff" borderRadius="$4">
          <QrCode value={waiting.qr} label="A code for your phone to scan" />
        </YStack>
      ) : null}
      <Text fontSize={14} color="$color" lineHeight={21} textAlign="center" maxWidth={380}>
        {expired ? 'The code has expired. Start again for a fresh one.' : result.detail}
      </Text>
      {expired ? null : (
        <XStack gap="$2" alignItems="center">
          <Spinner size="small" color="$accent" />
          <Text fontSize={12} color="$muted">
            Waiting for your phone…
          </Text>
        </XStack>
      )}
      <Button size="$2" chromeless color="$muted" onPress={onCancel}>
        {expired ? 'Start again' : 'Cancel'}
      </Button>
    </Card>
  );
}

/** One helper: its card, its own questions when it has any, and what it answers. */
export function ActionCard({
  flow,
  stepId,
  action,
  primary,
  busy,
  setBusy,
  onDone,
}: {
  flow: SetupFlow;
  stepId: string;
  action: SetupActionView;
  primary: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** It filled something in, or the person picked one of its candidates. */
  onDone: (choice: SetupChoice | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<ConfigValues>({});
  const [result, setResult] = useState<SetupActionResult | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (values: ConfigValues) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await flow.action(stepId, action.id, values);
        if (!next.ok && !next.choices?.length) {
          // Refused: said beside the questions, which stay, to be corrected and asked again.
          setResult(null);
          setOpen(true);
          setError(next.detail);
          return;
        }
        setResult(next);
        // Filled in without a choice: done.
        if (next.ok && !next.waiting && !next.choices?.length && next.suggestedConfig) onDone(null);
      } catch (err) {
        setError(describeError(err) || 'That did not work');
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [action.id, flow, onDone, setBusy, stepId]
  );

  const asks = action.input && Object.keys(action.input.fields).length > 0;
  const ready = !asks || isComplete(action.input!, input);

  return (
    <Card gap="$3" borderWidth={primary ? 1 : 0} borderColor="$accent">
      <YStack gap="$1">
        <Text fontSize={16} fontWeight="700" color="$color">
          {action.label}
        </Text>
        {action.description ? (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {action.description}
          </Text>
        ) : null}
      </YStack>

      {result?.waiting ? (
        <Waiting result={result} onAgain={(next) => void run(next)} onCancel={() => setResult(null)} />
      ) : result?.choices?.length ? (
        <Choices
          result={result}
          picking={picking}
          onPick={(choice) => {
            setPicking(choice.id);
            onDone(choice);
          }}
        />
      ) : open || !asks ? (
        <YStack gap="$3">
          {asks ? (
            <Card inset backgroundColor="$background">
              <SchemaForm schema={action.input!} values={input} disabled={busy} onChange={(name, value) => setInput((before) => ({ ...before, [name]: value }))} onSubmit={() => (!busy && ready ? void run(input) : undefined)} />
            </Card>
          ) : null}
          <Button alignSelf="flex-start" size="$3" {...(primary ? PRIMARY : {})} disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void run(input)}>
            {busy ? 'Working…' : asks ? 'Continue' : action.label}
          </Button>
        </YStack>
      ) : (
        <Button alignSelf="flex-start" size="$3" {...(primary ? PRIMARY : {})} disabled={busy} onPress={() => setOpen(true)}>
          {action.label}
        </Button>
      )}
      <ErrorLine message={error} />
    </Card>
  );
}
