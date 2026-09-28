import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '@kraftverk/ui';
import { Row, RowSeparator } from '@kraftverk/ui';
import { describeError } from '@kraftverk/api-client';

import type { RegisterDump, RegisterRow } from '../src/model/diagnostics';
import type { DeviceScreenProps } from './contract';
import { useStation } from './station';

/*
  What the MQTT transport's diagnostics say, as far as this screen reads them.
  Declared here, not imported: a device type never imports a transport, and
  the shapes arrive as data through whoever holds the connection.
*/
type BrokerDevice = {
  protocol: string;
  address: string;
  online: boolean;
  remote: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastDisconnect: string | null;
  keepalive: number | null;
  subscribed: boolean;
};
type BrokerView = {
  status: 'running' | 'starting' | 'down' | 'foreign';
  error: string | null;
  pid: number | null;
  startedAt: string | null;
  build: string | null;
  expectedBuild: string;
  buildMatches: boolean | null;
  listen: { host: string; port: number; listening: boolean };
  serverConnected: boolean;
  serverConnectedAt: string | null;
  serverError: string | null;
  devices: BrokerDevice[];
};
type JournalEntry = { seq: number; at: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; device?: string };
type TrafficEntry = { at: string; direction: 'in' | 'out'; address: string; topic: string; bytes: number; hex: string; summary: string; delivered: boolean };
type LinkState = { transport: string; address: string; connected: boolean };

/**
 * A button sitting on the page rather than on a card needs its own surface.
 *
 * Tamagui's default button background is the same colour as this theme's page
 * background, and its border is transparent, so these read as plain text —
 * "Snapshot baseline" looked like a caption rather than the control that drives
 * the whole register-diff workflow.
 */
const SECONDARY = {
  backgroundColor: '$backgroundStrong',
  borderColor: '$borderColor',
} as const;

/**
 * Ground truth for register work.
 *
 * The published register map was derived from FOSSiBOT F2400/F3600 hardware.
 * The P280 runs the same Sydpower stack but is a different machine, so this
 * screen exists to check the documented meaning of each register against what
 * your unit actually reports. The registers are read by the station's own
 * tools, through whoever holds its connection — the server, or this app.
 */
export function StationRegisters(props: DeviceScreenProps) {
  const { device, actions, holder, readOnly } = props;
  const { status } = useStation(props);
  const [link, setLink] = useState<LinkState | null>(null);
  const [broker, setBroker] = useState<BrokerView | null>(null);
  const [traffic, setTraffic] = useState<TrafficEntry[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [registers, setRegisters] = useState<RegisterDump | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);

  const reachable = holder === 'server' || holder === 'this-app';
  const inUse = device.connections.find((connection) => connection.inUse) ?? null;
  /** The broker, its journal and its traffic exist only for a Wi-Fi connection the server holds. */
  const onMqtt = holder === 'server' && inUse?.transport === 'mqtt' && actions.diagnostic !== null;
  const simulated = status?.link.mode === 'simulator';
  const hasLink = device.advanced.some((tool) => tool.name === 'link');
  const hasRegisters = device.advanced.some((tool) => tool.name === 'registers');

  const refresh = useCallback(async () => {
    if (!reachable) return;
    setBusy(true);
    try {
      if (hasLink) setLink(await actions.tool<LinkState>('link'));
      if (onMqtt && actions.diagnostic) {
        const address = inUse!.address.toUpperCase();
        // The broker's, so a broker that is down has none to give: its card says why.
        const [nextBroker, nextTraffic, nextJournal] = await Promise.all([
          actions.diagnostic<BrokerView>('broker').catch(() => null),
          actions.diagnostic<TrafficEntry[]>('traffic', { device: address, limit: 12 }).catch(() => []),
          actions.diagnostic<{ entries: JournalEntry[] }>('journal', { device: address, limit: 15 }).catch(() => null),
        ]);
        setBroker(nextBroker);
        setTraffic([...nextTraffic].reverse());
        setJournal(nextJournal ? [...nextJournal.entries].reverse() : []);
      }
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, [actions, hasLink, inUse, onMqtt, reachable]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dumpRegisters = useCallback(async () => {
    setBusy(true);
    try {
      setRegisters(await actions.tool<RegisterDump>('registers'));
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, [actions]);

  const snapshot = useCallback(async () => {
    setBusy(true);
    try {
      await actions.tool('snapshot');
      setRegisters(await actions.tool<RegisterDump>('registers'));
      setOnlyChanged(true);
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, [actions]);

  /** Nothing to dump until there is a station on the other end, and a simulator has no registers. */
  const noStation = !reachable || simulated || !hasRegisters || status?.link.state !== 'connected';
  /** Dimmed as well as inert: a bright button that ignores taps reads as broken. */
  const cannotRead = busy || noStation;

  return (
    <>
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
        <SectionLabel>Link</SectionLabel>
        <Card inset>
          <Row
            title="Held by"
            accessory={<Mono>{holder === 'server' ? 'the server' : holder === 'this-app' ? 'this app' : holder === 'other-app' ? 'another app' : 'nobody'}</Mono>}
            subtitle={inUse ? `${inUse.methodLabel} · ${inUse.address}` : device.health.detail}
          />
          <RowSeparator />
          <Row
            title="Station"
            accessory={<Mono>{simulated ? 'simulated' : link ? (link.connected ? 'connected' : 'not connected') : '—'}</Mono>}
            subtitle={simulated ? 'A simulator has no registers to read' : undefined}
          />
        </Card>
        {broker ? <BrokerCard broker={broker} /> : null}
      </YStack>

      <XStack gap="$3" flexWrap="wrap">
        {!reachable ? null : (
          <Button flex={1} size="$3" {...SECONDARY} onPress={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
        )}
        <Button
          flex={1}
          size="$3"
          backgroundColor="$accent"
          color="$background"
          onPress={() => void dumpRegisters()}
          disabled={cannotRead}
          opacity={cannotRead ? 0.45 : 1}
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
        <Button
          flex={1}
          size="$3"
          {...SECONDARY}
          onPress={() => void snapshot()}
          disabled={cannotRead}
          opacity={cannotRead ? 0.45 : 1}
        >
          Snapshot baseline
        </Button>
        <Button
          flex={1}
          size="$3"
          {...SECONDARY}
          onPress={() => setOnlyChanged((v) => !v)}
          disabled={!registers?.baselineAt}
          opacity={registers?.baselineAt ? 1 : 0.45}
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

      {/* The journal and the frame log are the broker's; the other links have no broker. */}
      <YStack gap="$2" display={broker ? undefined : 'none'}>
        <SectionLabel>Broker journal</SectionLabel>
        <Card inset>
          {journal.length === 0 ? (
            <Row
              title="Nothing recorded yet"
              subtitle="Connections, subscriptions, writes and every disconnect with its reason appear here"
            />
          ) : (
            journal.map((entry, index) => (
              <YStack key={entry.seq}>
                {index > 0 ? <RowSeparator /> : null}
                <XStack paddingHorizontal="$4" paddingVertical="$2.5" gap="$3" alignItems="flex-start">
                  <Text fontSize={11} color="$muted" fontVariant={['tabular-nums']} width={58} paddingTop={1}>
                    {hms(entry.at)}
                  </Text>
                  <Text
                    flex={1}
                    fontSize={12}
                    lineHeight={17}
                    color={entry.level === 'error' ? '$danger' : entry.level === 'warn' ? '$warning' : '$color'}
                  >
                    {entry.message}
                  </Text>
                </XStack>
              </YStack>
            ))
          )}
        </Card>
        <Text fontSize={12} color="$muted" paddingHorizontal="$1" lineHeight={18}>
          The full record, including every poll and telemetry frame, is in the broker's journal files.
          From the repository: npm run broker:logs
        </Text>
      </YStack>

      <YStack gap="$2" display={broker ? undefined : 'none'}>
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
                    <Text
                      fontSize={12}
                      fontWeight="700"
                      color={entry.delivered ? '$color' : '$warning'}
                      numberOfLines={1}
                      flex={1}
                    >
                      {entry.direction === 'out' ? '→ ' : '← '}
                      {entry.summary || entry.topic.replace(/^[0-9A-F]{12}\//, '')}
                    </Text>
                    <Text fontSize={11} color="$muted">
                      {new Date(entry.at).toLocaleTimeString()} · {entry.bytes} B
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
    </>
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

const BROKER_STATUS: Record<BrokerView['status'], string> = {
  running: 'running',
  starting: 'starting',
  down: 'down',
  foreign: 'port taken',
};

/** "4 min", "2 h 5 min", "3 d" — how long something has been the way it is. */
function span(fromIso: string | null): string {
  if (!fromIso) return '?';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d`;
}

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '?');

/**
 * 21:04:07, in every locale. The journal's time column is a fixed width, and
 * `toLocaleTimeString` is "9:04:07 PM" in some — which wraps.
 */
function hms(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The broker, and the stations on it.
 *
 * It runs as a process of its own so that restarting the server does not drop
 * the station — a station that loses its broker for long enough stops trying to
 * come back. So this card has two connections to report, and they fail
 * separately: the station to the broker, and the server to the broker.
 */
function BrokerCard({ broker }: { broker: BrokerView }) {
  return (
    <YStack gap="$2">
      <SectionLabel>MQTT broker</SectionLabel>
      <Card inset>
        <Row
          title="Broker"
          accessory={<Mono>{BROKER_STATUS[broker.status]}</Mono>}
          subtitle={
            broker.status === 'running'
              ? `Process ${broker.pid}, up ${span(broker.startedAt)}. Stations connect to port ${broker.listen.port}. ` +
                'It keeps running when the server restarts.'
              : (broker.error ?? undefined)
          }
        />
        {broker.buildMatches === false ? (
          <>
            <RowSeparator />
            <Row
              title="Running older code"
              subtitle={
                `This broker is build ${broker.build}; the code on disk is ${broker.expectedBuild}. It is left ` +
                'running because restarting it drops the station. Run npm run broker:restart when that is fine.'
              }
            />
          </>
        ) : null}
        <RowSeparator />
        <Row
          title="Server connection"
          accessory={<Mono>{broker.serverConnected ? 'connected' : 'not connected'}</Mono>}
          subtitle={
            broker.serverConnected
              ? `Since ${clock(broker.serverConnectedAt)}`
              : (broker.serverError ?? 'Connecting…')
          }
        />
        {broker.devices.length === 0 ? (
          <>
            <RowSeparator />
            <Row
              title="Stations"
              accessory={<Mono>0</Mono>}
              subtitle={
                "None has connected yet. In BrightEMS, set this server's address as the Local MQTT Broker " +
                '(or point mqtt.sydpower.com here), then power-cycle the station.'
              }
            />
          </>
        ) : (
          broker.devices.map((station) => (
            <YStack key={station.address}>
              <RowSeparator />
              <Row
                title={station.address}
                accessory={<Mono>{station.online ? 'online' : 'offline'}</Mono>}
                subtitle={
                  station.online
                    ? `From ${station.remote?.split(':')[0] ?? '?'} for ${span(station.connectedAt)}` +
                      (station.keepalive ? `, keepalive ${station.keepalive} s` : '') +
                      (station.subscribed ? '' : '. Not subscribed to its command topic yet, so commands cannot reach it')
                    : // No departure time: remembered from a broker that did not stop cleanly.
                      (station.disconnectedAt ? `Gone for ${span(station.disconnectedAt)}` : 'Not connected') +
                      (station.lastDisconnect ? `: ${station.lastDisconnect}` : '') +
                      '. If it does not come back, power-cycle it.'
                }
              />
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
