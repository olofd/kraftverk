import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '../../src/components/Card';
import { Row, RowSeparator } from '../../src/components/Row';
import { Screen } from '../../src/components/Screen';
import {
  describeError,
  fetchLinkDiagnostics,
  fetchRegisters,
  fetchTraffic,
  snapshotRegisters,
  type RegisterDump,
  type RegisterRow,
} from '../../src/lib/api';
import type { LinkDiagnostics, TrafficEntry } from '../../src/lib/types';
import { useStation } from '../../src/state/StationProvider';

/**
 * Ground truth for protocol work.
 *
 * The published register map was derived from FOSSiBOT F2400/F3600 hardware.
 * The P280 runs the same Sydpower stack but is a different machine, so this
 * screen exists to check the documented meaning of each register against what
 * your unit actually reports.
 */
export default function DiagnosticsScreen() {
  const { status, version } = useStation();
  const [link, setLink] = useState<LinkDiagnostics | null>(null);
  const [traffic, setTraffic] = useState<TrafficEntry[]>([]);
  const [registers, setRegisters] = useState<RegisterDump | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [nextLink, nextTraffic] = await Promise.all([fetchLinkDiagnostics(), fetchTraffic()]);
      setLink(nextLink);
      setTraffic(nextTraffic.slice(-12).reverse());
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dumpRegisters = useCallback(async () => {
    setBusy(true);
    try {
      setRegisters(await fetchRegisters());
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  const snapshot = useCallback(async () => {
    setBusy(true);
    try {
      await snapshotRegisters();
      setRegisters(await fetchRegisters());
      setOnlyChanged(true);
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  const simulated = status?.link.mode === 'simulator';
  const readOnly = version?.readOnly ?? false;

  return (
    <Screen title="Protocol" subtitle="Verify the register map against real hardware">
      {readOnly ? (
        <Card borderColor="$success" gap="$2">
          <Text fontSize={14} fontWeight="700" color="$success">
            Read-only mode
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            Every write is refused before a frame is built. You can poll and decode freely without
            any risk of changing the station.
          </Text>
        </Card>
      ) : null}

      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>MQTT broker</SectionLabel>
        <Card inset>
          <Row
            title="Driver"
            accessory={<Mono>{link?.driver ?? '—'}</Mono>}
            subtitle={simulated ? 'Set STATION_DRIVER=device to talk to hardware' : undefined}
          />
          <RowSeparator />
          <Row
            title="Listening"
            accessory={<Mono>{link ? (link.brokerListening ? 'yes' : 'no') : '—'}</Mono>}
            subtitle={link ? `${link.mqtt.host}:${link.mqtt.port}` : undefined}
          />
          <RowSeparator />
          <Row
            title="Stations seen"
            accessory={<Mono>{link?.devices.length ?? 0}</Mono>}
            subtitle={
              link?.devices.length
                ? link.devices.map((d) => d.mac).join(', ')
                : 'None yet — point mqtt.sydpower.com here and power-cycle the P280'
            }
          />
        </Card>
      </YStack>

      <XStack gap="$3" flexWrap="wrap">
        <Button flex={1} size="$3" onPress={() => void refresh()} disabled={busy}>
          Refresh
        </Button>
        <Button
          flex={1}
          size="$3"
          backgroundColor="$accent"
          color="$background"
          onPress={() => void dumpRegisters()}
          disabled={busy || simulated}
        >
          Dump registers
        </Button>
      </XStack>

      {/*
        Snapshot, change one thing on the station, dump again: whatever moved is
        the register behind that control. This is how the map gets confirmed on
        hardware it was not derived from.
      */}
      <XStack gap="$3" flexWrap="wrap">
        <Button flex={1} size="$3" onPress={() => void snapshot()} disabled={busy || simulated}>
          Snapshot baseline
        </Button>
        <Button
          flex={1}
          size="$3"
          onPress={() => setOnlyChanged((v) => !v)}
          disabled={!registers?.baselineAt}
        >
          {onlyChanged ? 'Show all' : 'Show changed only'}
        </Button>
      </XStack>

      {registers?.baselineAt ? (
        <Text fontSize={12} color="$muted" paddingHorizontal="$1">
          Baseline captured {new Date(registers.baselineAt).toLocaleTimeString()}. Change something
          on the station or in BrightEMS, then dump again to see which registers moved.
        </Text>
      ) : null}

      {busy ? <Spinner color="$accent" /> : null}

      {registers ? (
        <>
          <RegisterTable
            title="Input registers (0x04)"
            rows={registers.input}
            onlyChanged={onlyChanged}
          />
          <RegisterTable
            title="Holding registers (0x03)"
            rows={registers.holding}
            onlyChanged={onlyChanged}
          />
        </>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Recent MQTT traffic</SectionLabel>
        <Card inset>
          {traffic.length === 0 ? (
            <Row title="Nothing captured yet" subtitle="Frames appear here as the station talks" />
          ) : (
            traffic.map((entry, index) => (
              <YStack key={`${entry.at}-${index}`}>
                {index > 0 ? <RowSeparator /> : null}
                <YStack paddingHorizontal="$4" paddingVertical="$3" gap="$1">
                  <XStack justifyContent="space-between" gap="$2">
                    <Text fontSize={12} fontWeight="700" color="$color" numberOfLines={1}>
                      {entry.topic.replace(/^[0-9A-F]{12}\//, '')}
                    </Text>
                    <Text fontSize={11} color="$muted">
                      {entry.bytes} B
                    </Text>
                  </XStack>
                  <Text
                    fontSize={10}
                    color="$muted"
                    fontFamily="monospace"
                    numberOfLines={2}
                  >
                    {entry.hex}
                  </Text>
                </YStack>
              </YStack>
            ))
          )}
        </Card>
      </YStack>
    </Screen>
  );
}

/** Only registers with a non-zero value or a documented name are worth showing. */
function RegisterTable({
  title,
  rows,
  onlyChanged,
}: {
  title: string;
  rows: RegisterRow[];
  onlyChanged: boolean;
}) {
  const interesting = rows.filter((r) =>
    onlyChanged ? r.changed : r.raw !== 0 || r.name || r.changed
  );

  return (
    <YStack gap="$2">
      <SectionLabel>{title}</SectionLabel>
      <Card inset>
        {interesting.length === 0 ? (
          <Row
            title={onlyChanged ? 'Nothing changed' : 'No data'}
            subtitle={
              onlyChanged
                ? 'Change something on the station, then dump again'
                : 'Is the station connected?'
            }
          />
        ) : (
          interesting.map((row, index) => (
            <YStack key={row.register} backgroundColor={row.changed ? '$backgroundPress' : undefined}>
              {index > 0 ? <RowSeparator /> : null}
              <XStack
                paddingHorizontal="$4"
                paddingVertical="$2"
                alignItems="center"
                gap="$3"
                justifyContent="space-between"
              >
                <Text
                  fontSize={12}
                  color={row.changed ? '$warning' : '$muted'}
                  width={28}
                  fontVariant={['tabular-nums']}
                >
                  {row.register}
                </Text>
                <Text fontSize={12} color="$color" flex={1} numberOfLines={1}>
                  {row.name ?? '—'}
                </Text>
                {row.changed && row.previous !== null ? (
                  <Text fontSize={12} color="$muted" fontFamily="monospace">
                    {row.previous} →
                  </Text>
                ) : null}
                <Text
                  fontSize={12}
                  color={row.changed ? '$warning' : '$accent'}
                  fontFamily="monospace"
                >
                  0x{row.hex}
                </Text>
                <Text
                  fontSize={12}
                  color="$color"
                  width={64}
                  textAlign="right"
                  fontVariant={['tabular-nums']}
                >
                  {row.raw}
                </Text>
              </XStack>
            </YStack>
          ))
        )}
      </Card>
    </YStack>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Text fontSize={14} fontWeight="700" color="$color" fontFamily="monospace">
      {children}
    </Text>
  );
}
