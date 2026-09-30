import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { describeError, startAutomation, stopAutomation, type AutomationView } from '@kraftverk/api-client';
import { haptic, Icon } from '@kraftverk/ui';

import { confirmAction } from '../../lib/confirm';
import { OUTCOME, stopwatch, useNow, useTone } from './looks';

/**
 * Playing an automation, and stopping it while it runs
 * (docs/AUTOMATION-EDITOR.md) — on its card, on a device's page, and on the
 * home page.
 *
 * Start runs it now, for real, whatever it does on its own: its steps each
 * go through the gateway, as a tap on a switch does. One that only watches
 * on its own asks first, every time — it has not been let act, and this
 * acts. While it runs, Stop ends the step it is in and runs what it does if
 * stopped. Off, it cannot be started, and says so.
 */
export function RunControl({
  automation,
  onChanged,
  compact,
}: {
  automation: AutomationView;
  onChanged: (next: AutomationView) => void;
  /** One line, for a device's page or the home page. */
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
      // Only watching on its own: started by a person, it acts — said, and asked, first.
      if (automation.mode === 'observe') {
        const yes = await confirmAction(`Start “${automation.name}” now?`, `It only watches on its own, but started by you it acts, for real:\n\n${automation.sentence}`, 'Start it');
        if (!yes) return;
      }
      onChanged(await startAutomation(automation.id));
    });
  const stop = () => act(async () => onChanged(await stopAutomation(automation.id)));

  const last = automation.lastRun;
  const blocked = automation.mode === 'off' || automation.problems.length > 0;
  const status = running
    ? `Running for ${stopwatch((now - Date.parse(running.at)) / 1000)}${current ? ` · ${current.what}` : ''}`
    : automation.mode === 'off'
      ? 'Off: turn it on to start it'
      : automation.problems.length
        ? `It cannot run as it is: ${automation.problems[0]}`
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
      backgroundColor="$accent"
      color="$background"
      disabled={busy || blocked}
      opacity={busy || blocked ? 0.5 : 1}
      icon={<Icon name="play" size={14} color={tone('$background')} />}
      onPress={() => void start()}
      aria-label={`Start ${automation.name}`}
    >
      Start
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
