import { useEffect, useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { describeError, type DeviceView } from '@kraftverk/api-client';
import { Card, haptic, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useHome } from '../../state/HomeProvider';

/** "3:12": what is left of a countdown, in minutes and seconds. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Seconds left until `until`, ticking each second; 0 when it has passed, or there is none. */
function useSecondsLeft(until: string | null): number {
  const left = () => (until ? Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000)) : 0);
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (!until) return;
    const timer = setInterval(() => setSeconds(left()), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return seconds;
}

/**
 * Pairing a device with a bridge that devices join — a Zigbee coordinator
 * (docs/PLAN-ZIGBEE.md §3.2): letting them join for a few minutes, a
 * countdown while it does, and what to do to the device. Each one that
 * joins appears under *Through it*, "Joining…" until its bridge knows what
 * it is, then to add. Nothing for a device nothing joins.
 */
export function Joining({ device }: { device: DeviceView }) {
  const { api } = useHome();
  const [until, setUntil] = useState<string | null>(device.joins?.until ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the device says wins: joining ended early, or was opened elsewhere.
  useEffect(() => setUntil(device.joins?.until ?? null), [device.joins?.until]);
  const left = useSecondsLeft(until);
  if (!device.joins) return null;
  const open = left > 0;

  const join = async (seconds: number) => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      setUntil((await api.devices.join(device.id, seconds)).until);
    } catch (err) {
      setError(describeError(err) || 'It could not be asked');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Pair a device</SectionLabel>
      <Card gap="$3" borderColor={open ? '$accent' : '$borderColor'}>
        <Text fontSize={15} fontWeight="700" color={open ? '$accent' : '$color'}>
          {open ? `Letting devices join — ${clock(left)} left` : 'Add a new device'}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {open
            ? 'Put the device in pairing mode now: most plugs and bulbs by holding their button for about five seconds until a light blinks; a sensor by pressing its reset button. It appears under Through it below, and is ready to add once it has said what it is.'
            : 'Let devices join for a few minutes, then put the device in pairing mode. Only devices put in pairing mode while it lets them can join.'}
        </Text>
        {device.readOnly ? (
          <Text fontSize={12} color="$warning">
            This server refuses every write to hardware now, and letting devices join is one. Allow writes in App settings first.
          </Text>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <XStack gap="$2" flexWrap="wrap">
          {open ? (
            <>
              <Button size="$3" disabled={busy} onPress={() => void join(device.joins!.maxSeconds)}>
                More time
              </Button>
              <Button size="$3" chromeless color="$muted" disabled={busy} onPress={() => void join(0)}>
                Stop
              </Button>
            </>
          ) : (
            <Button size="$3" backgroundColor="$accent" color="$background" disabled={busy || device.readOnly} onPress={() => void join(device.joins!.maxSeconds)}>
              {busy ? 'Asking…' : 'Let devices join'}
            </Button>
          )}
        </XStack>
      </Card>
    </YStack>
  );
}
