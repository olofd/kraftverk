import { useState } from 'react';
import type { PluginPanelProps } from '@kraftverk/plugin-sdk';
import { Button, Text, XStack, YStack } from 'tamagui';

/**
 * The Tuya plug's own screen.
 *
 * This file is the plugin's, not the app's — it lives in the plugin package and
 * the app picks it up through a compile-time registry. Delete the package and
 * this goes with it; ship the package without this file and the generic screen
 * still configures the plug perfectly well.
 *
 * It earns its place by showing the two things a generic renderer cannot: live
 * metering read straight off the plug, and a switch whose consequences need
 * spelling out before it is pressed.
 *
 * Note what it does *not* do: it has no protocol access, no socket, no key. It
 * calls `switchRelay`, which is the same action gateway path the generic
 * control uses, with the same grant, dwell, freshness and verification checks.
 */
export default function TuyaPanel({
  relay,
  grants,
  isActiveProvider,
  switchRelay,
  refresh,
}: PluginPanelProps) {
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const maySwitch = grants.includes('gridRelay.switch') && isActiveProvider && switchRelay;
  const on = relay?.relayOn ?? false;
  const stale = relay ? Date.now() - new Date(relay.updatedAt).getTime() > 60_000 : true;

  const send = async (next: boolean) => {
    if (!switchRelay) return;
    setBusy(true);
    setConfirming(null);
    try {
      const outcome = await switchRelay(
        next,
        next ? 'Grid AC restored from the app' : 'Grid AC removed from the app'
      );
      setResult(outcome.detail);
      await refresh();
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3">
      <XStack gap="$3" flexWrap="wrap">
        <Reading label="Relay" value={relay ? (on ? 'On' : 'Off') : '—'} tint={on ? '$success' : '$muted'} />
        <Reading label="Power" value={relay?.watts !== undefined ? `${Math.round(relay.watts)} W` : '—'} />
        <Reading label="Voltage" value={relay?.volts !== undefined ? `${relay.volts.toFixed(1)} V` : '—'} />
        <Reading label="Current" value={relay?.amps !== undefined ? `${relay.amps.toFixed(2)} A` : '—'} />
        <Reading label="Energy" value={relay?.kwh !== undefined ? `${relay.kwh.toFixed(2)} kWh` : '—'} />
      </XStack>

      {/* Never a green light over old numbers. */}
      {relay && stale ? (
        <Text fontSize={12} color="$warning">
          These readings are older than a minute — the plug may have stopped answering.
        </Text>
      ) : null}

      {!maySwitch ? (
        <Text fontSize={12} color="$muted" lineHeight={18}>
          {isActiveProvider
            ? 'Grant “switch the grid relay” below to control mains from here.'
            : 'Set this plugin as the grid-relay provider to control it from here.'}
        </Text>
      ) : confirming === null ? (
        <XStack gap="$2">
          <Button
            flex={1}
            size="$3"
            disabled={busy}
            backgroundColor={on ? undefined : '$accent'}
            color={on ? undefined : '$background'}
            onPress={() => setConfirming(true)}
          >
            Turn grid AC on
          </Button>
          <Button flex={1} size="$3" disabled={busy} onPress={() => setConfirming(false)}>
            Cut grid AC
          </Button>
        </XStack>
      ) : (
        /*
          The second step is not ceremony. Cutting this relay drops the mains
          feed to the station, so the consequence is stated in the words of the
          thing that happens, not "are you sure?".
        */
        <YStack
          gap="$2"
          padding="$3"
          borderRadius="$4"
          borderWidth={1}
          borderColor={confirming ? '$borderColor' : '$warning'}
        >
          <Text fontSize={13} fontWeight="700" color={confirming ? '$color' : '$warning'}>
            {confirming
              ? 'Restore mains to the station?'
              : 'Cut mains to the station?'}
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            {confirming
              ? 'The station can charge and run on bypass again.'
              : 'Everything plugged into the station runs from its battery and solar until the relay is turned back on. Do not do this with medical, heating, security or network equipment connected.'}
          </Text>
          <XStack gap="$2">
            <Button
              flex={1}
              size="$3"
              backgroundColor={confirming ? '$accent' : '$warning'}
              color="$background"
              disabled={busy}
              onPress={() => void send(confirming)}
            >
              {busy ? 'Working…' : confirming ? 'Restore AC' : 'Cut AC'}
            </Button>
            <Button flex={1} size="$3" disabled={busy} onPress={() => setConfirming(null)}>
              Cancel
            </Button>
          </XStack>
        </YStack>
      )}

      {result ? (
        <Text fontSize={12} color="$muted" lineHeight={18}>
          {result}
        </Text>
      ) : null}
    </YStack>
  );
}

function Reading({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <YStack gap={2} minWidth={72}>
      <Text fontSize={11} color="$muted" fontWeight="700">
        {label}
      </Text>
      <Text fontSize={15} fontWeight="700" color={tint ?? '$color'} fontVariant={['tabular-nums']}>
        {value}
      </Text>
    </YStack>
  );
}
