import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { checkAutomation, describeError, startAutomation, stopAutomation, type AutomationRun, type AutomationView } from '@kraftverk/api-client';
import { haptic, Icon } from '@kraftverk/ui';

import { OUTCOME, stopwatch, useNow, useTone } from './looks';

/**
 * Starting one that is started when asked, and stopping it while it runs
 * (docs/SEQUENCES.md) — on its card, and on the page of a device it is about.
 *
 * Letting it act, Start begins its run; while it runs, Stop ends the step it
 * is in and runs what it does if stopped. Only watching, it is tried instead:
 * what it would do is shown, and nothing is switched. Off, it says so.
 */
export function RunControl({
  automation,
  onChanged,
  onTried,
  compact,
}: {
  automation: AutomationView;
  onChanged: (next: AutomationView) => void;
  /** What it would do, when it only watches and was tried. */
  onTried?: (run: AutomationRun) => void;
  /** One line, for a device's page. */
  compact?: boolean;
}) {
  const tone = useTone();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const running = automation.running;
  const now = useNow(running !== null);
  // The step it is in: the last still going, else the last taken.
  const current = running ? ([...running.steps].reverse().find((step) => step.outcome === 'waiting') ?? running.steps[running.steps.length - 1] ?? null) : null;

  const act = async (work: () => Promise<void>) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(async () => {
      if (automation.mode === 'observe') onTried?.(await checkAutomation(automation.id));
      else onChanged(await startAutomation(automation.id));
    });
  const stop = () => act(async () => onChanged(await stopAutomation(automation.id)));

  const last = automation.lastRun;
  const status = running
    ? `Running for ${stopwatch((now - Date.parse(running.at)) / 1000)}${current ? ` · ${current.what}` : ''}`
    : automation.mode === 'off'
      ? 'Off: turn it on to start it'
      : automation.mode === 'observe'
        ? 'It only watches: trying it shows what it would do, and switches nothing'
        : last
          ? `Last: ${OUTCOME[last.outcome].label.toLowerCase()} — ${last.summary}`
          : 'Not started yet';

  const button = running ? (
    <Button
      size={compact ? '$3' : '$4'}
      borderWidth={1}
      borderColor="$danger"
      backgroundColor="transparent"
      color="$danger"
      disabled={busy}
      icon={<Icon name="square" size={14} color={tone('$danger')} />}
      onPress={() => void stop()}
      aria-label={`Stop ${automation.name}`}
    >
      Stop
    </Button>
  ) : (
    <Button
      size={compact ? '$3' : '$4'}
      backgroundColor={automation.mode === 'armed' ? '$accent' : 'transparent'}
      borderWidth={automation.mode === 'armed' ? 0 : 1}
      borderColor="$accent"
      color={automation.mode === 'armed' ? '$background' : '$accent'}
      disabled={busy || automation.mode === 'off' || automation.problems.length > 0}
      opacity={busy || automation.mode === 'off' || automation.problems.length > 0 ? 0.5 : 1}
      icon={<Icon name={automation.mode === 'armed' ? 'play' : 'eye'} size={14} color={tone(automation.mode === 'armed' ? '$background' : '$accent')} />}
      onPress={() => void start()}
      aria-label={`${automation.mode === 'armed' ? 'Start' : 'Try'} ${automation.name}`}
    >
      {automation.mode === 'armed' ? 'Start' : 'Try it'}
    </Button>
  );

  return (
    <YStack gap="$2">
      <XStack gap="$3" alignItems="center">
        {compact ? (
          <YStack flex={1} gap={2}>
            <Text fontSize={15} fontWeight="700" color="$color" numberOfLines={1}>
              {automation.name}
            </Text>
            <Text fontSize={12} color={running ? '$accent' : '$muted'} numberOfLines={2} lineHeight={17}>
              {status}
            </Text>
          </YStack>
        ) : null}
        {button}
        {compact ? null : (
          <Text flex={1} fontSize={13} color={running ? '$accent' : '$muted'} lineHeight={19} fontWeight={running ? '600' : '400'} role="status">
            {status}
          </Text>
        )}
      </XStack>
      {problem ? (
        <XStack gap="$2" alignItems="flex-start" role="alert">
          <Icon name="alert-circle" size={14} color={tone('$danger')} style={{ marginTop: 2 }} />
          <Text flex={1} fontSize={13} color="$danger" lineHeight={19}>
            {problem}
          </Text>
        </XStack>
      ) : null}
    </YStack>
  );
}
