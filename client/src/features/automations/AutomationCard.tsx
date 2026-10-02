import { router } from 'expo-router';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import type { AutomationView } from '@kraftverk/api-client';
import { Card, Icon, type IconName } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { useTone } from '../../components/tone';
import { useRun } from './useRun';

/**
 * An automation, small (docs/AUTOMATIONS-UX.md): what starts it, its name,
 * how it stands in a line, and a button that runs it now — or stops it while
 * it runs. The same card in the list of automations, among the shortcuts on
 * the home page, and on a device's page. Its name opens its own page.
 */
export function AutomationCard({ automation, onChanged }: { automation: AutomationView; onChanged: (next: AutomationView) => void }) {
  const tone = useTone();
  const run = useRun(automation, onChanged);
  const running = run.running !== null;
  const acting = automation.mode === 'act';
  const off = automation.mode === 'off';

  return (
    <Card inset role="group" aria-label={automation.name} borderColor={running ? '$accent' : '$borderColor'}>
      <XStack alignItems="center" gap="$3" paddingRight="$3">
        <YStack flex={1}>
          <Pressable onPress={() => router.push(`/automation/${automation.id}`)} label={`${automation.name}: ${run.status}. Open`}>
            <XStack alignItems="center" gap="$3" paddingLeft="$3" paddingVertical="$3" minHeight={72}>
              {/* How it starts, in a square: filled when it acts on its own, outlined while it only watches, grey when off. */}
              <YStack
                width={40}
                height={40}
                borderRadius={12}
                alignItems="center"
                justifyContent="center"
                backgroundColor={acting ? '$accent' : 'transparent'}
                borderWidth={acting ? 0 : 1.5}
                borderColor={off ? '$borderColor' : '$accent'}
              >
                <Icon name={startsBy(automation)} size={18} color={tone(acting ? '$background' : off ? '$muted' : '$accent')} />
              </YStack>
              <YStack flex={1} gap={2}>
                <Text fontSize={16} fontWeight="700" color="$color" numberOfLines={1}>
                  {automation.name}
                </Text>
                <Text fontSize={13} lineHeight={18} color={running ? '$accent' : '$muted'} numberOfLines={1} role="status">
                  {run.status}
                </Text>
              </YStack>
            </XStack>
          </Pressable>
        </YStack>
        <PlayButton name={automation.name} running={running} busy={run.busy} blocked={run.blocked} onStart={() => void run.start()} onStop={() => void run.stop()} />
      </XStack>
      {run.problem ? (
        <Text paddingHorizontal="$3" paddingBottom="$3" fontSize={13} color="$danger" lineHeight={18} role="alert">
          {run.problem}
        </Text>
      ) : null}
    </Card>
  );
}

/** Run now, or stop: round, 44 px, the one action a card has besides opening. */
export function PlayButton({ name, running, busy, blocked, onStart, onStop }: { name: string; running: boolean; busy: boolean; blocked: string | null; onStart: () => void; onStop: () => void }) {
  const tone = useTone();
  if (running) {
    return (
      <Button
        width={44}
        height={44}
        circular
        borderWidth={1.5}
        borderColor="$danger"
        backgroundColor="transparent"
        disabled={busy}
        aria-label={`Stop ${name}`}
        icon={busy ? <Spinner size="small" color="$danger" /> : <Icon name="square" size={16} color={tone('$danger')} />}
        onPress={onStop}
      />
    );
  }
  return (
    <Button
      width={44}
      height={44}
      circular
      backgroundColor={blocked ? '$backgroundPress' : '$accent'}
      disabled={busy || blocked !== null}
      opacity={busy ? 0.6 : 1}
      aria-label={blocked ? `Start ${name} — ${blocked}` : `Start ${name}`}
      // A triangle's weight sits left of its box's centre: shifted by a tenth of its size, it looks centred.
      icon={busy ? <Spinner size="small" color="$background" /> : <Icon name="play" size={18} color={tone(blocked ? '$muted' : '$background')} style={{ marginLeft: 2 }} />}
      onPress={onStart}
    />
  );
}

/** What starts it, as an icon: a time, an interval, a condition, a device's event — or, with nothing, you. */
export function startsBy(automation: Pick<AutomationView, 'rule'>): IconName {
  const first = automation.rule.when[0];
  if (!first) return 'play-circle';
  if ('at' in first) return 'clock';
  if ('every' in first) return 'repeat';
  if ('event' in first) return 'bell';
  return 'activity';
}
