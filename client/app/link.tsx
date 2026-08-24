import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '@kraftverk/ui';
import { ModeRow, Row, RowSeparator, ToggleRow } from '@kraftverk/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '../src/components/Screen';
import { SegmentedControl } from '@kraftverk/ui';
import {
  bindStation,
  describeError,
  fetchStationTransports,
  unbindStation,
} from '@kraftverk/api-client';
import { formatAgo } from '@kraftverk/ui';
import { haptic } from '@kraftverk/ui';
import type { StationTransports } from '@kraftverk/api-client';
import { useDirectLink, type LinkSource } from '../src/state/DirectLinkProvider';

/**
 * How the app reaches the station, and which station.
 *
 * There are two ways in. The server can hold the link — over its embedded MQTT
 * broker or its own Bluetooth adapter — and the app talks HTTP to it; or the
 * app can hold the Bluetooth link itself, with no server involved at all.
 * Both decode with the same protocol package, so nothing below this choice
 * changes: the same registers, the same write whitelist, the same numbers.
 *
 * Only one of them can be connected at a time. These stations accept a single
 * Bluetooth connection, so a phone holding it locks out the server, and the
 * vendor app locks out both.
 *
 * This is not the Devices screen and deliberately no longer sits in the tabs. A
 * device is a thing you own; this is plumbing for reaching one of them, and it
 * belongs behind the station rather than beside the plug.
 */
const SOURCES = [
  { value: 'server', label: 'Server' },
  { value: 'direct', label: 'This device' },
] as const satisfies readonly { value: LinkSource; label: string }[];

/** What to call each radio on screen. */
const TRANSPORT_LABEL: Record<string, string> = {
  ble: 'Bluetooth LE',
  mqtt: 'WiFi / MQTT',
  sim: 'Simulator',
};

export default function LinkScreen() {
  const { status, refresh, source, setSource, direct } = useDirectLink();
  const { connection } = useLocalSearchParams<{ connection?: string }>();

  /*
    Arriving from "Connect over Bluetooth" means this device, not the server.

    Without it the screen opens on whichever side is currently active — so
    pressing a button that says Bluetooth landed you on a panel reporting
    "Transport: WiFi / MQTT", which reads as a broken screen rather than as the
    server's honest answer to a different question.

    Applied here rather than at the button because switching sides deselects
    the active server, and this is the screen where that is visible and one tap
    from being undone.
  */
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || connection !== 'direct') return;
    applied.current = true;
    setSource('direct');
  }, [connection, setSource]);

  return (
    <Screen back="Your devices" title="Station link" subtitle="How this app reaches your power station">
      <Card inset>
        <SegmentedControl
          title="Connection"
          subtitle={
            source === 'server'
              ? 'The server holds the link over WiFi or its own Bluetooth adapter, and this app talks to the server.'
              : `This ${Platform.OS === 'web' ? 'browser' : 'phone'} connects to the station over Bluetooth directly. No server needed.`
          }
          value={source}
          options={SOURCES}
          onChange={setSource}
        />
      </Card>

      {source === 'server' ? (
        <ServerLink status={status} refresh={refresh} />
      ) : (
        <DirectLink direct={direct} />
      )}
    </Screen>
  );
}

/**
 * Discovery and binding through the server.
 *
 * Stations announce themselves differently per transport — over MQTT the first
 * message reveals the MAC, over BLE they advertise a name — but both end up here
 * as something you can bind. The binding is persisted server-side, so a restart
 * reconnects to the same unit.
 */
function ServerLink({
  status,
  refresh,
}: {
  status: ReturnType<typeof useDirectLink>['status'];
  refresh: () => Promise<void>;
}) {
  const [list, setList] = useState<StationTransports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Peripherals that never announced themselves as a station, folded away. */
  const [showOther, setShowOther] = useState(false);
  const theme = useTheme();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      setList(await fetchStationTransports());
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const bind = useCallback(
    async (deviceId: string, stationId: string) => {
      haptic();
      setBusy(true);
      try {
        await bindStation(deviceId, stationId);
        await Promise.all([load(), refresh()]);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
      } finally {
        setBusy(false);
      }
    },
    [load, refresh]
  );

  const unbind = useCallback(async (deviceId: string) => {
    haptic();
    setBusy(true);
    try {
      await unbindStation(deviceId);
      await Promise.all([load(), refresh()]);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, [load, refresh]);

  const simulated = status?.link.mode === 'simulator';

  const links = list?.links ?? [];

  /**
   * Which saved device a bind is for.
   *
   * Explicit, and shown. The server no longer accepts a bind that does not name
   * its device, which is right: "the station" stopped being a thing the moment
   * a second one could exist. Defaults to the one still waiting for a link, and
   * is chosen below when more than one is.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  /*
    A choice only counts while the device it names is still on the list. Sessions
    come and go, so the device picked here can leave — and preferring a stale id
    would bind the station to a device this screen has stopped naming, which is
    worse than quietly falling back to the one it does name.
  */
  const target =
    (chosen && links.some((entry) => entry.deviceId === chosen) ? chosen : null) ??
    links.find((entry) => !entry.stationId)?.deviceId ??
    links[0]?.deviceId ??
    null;

  /** Which saved device holds a given station, so Unbind knows whose link it is. */
  const ownerOf = (stationId: string) =>
    links.find((entry) => entry.stationId?.toLowerCase() === stationId.toLowerCase())?.deviceId ??
    null;

  /*
    Two lists, not one dimmed sequence.

    A power station announces itself; everything else in radio range — headphones,
    a watch, a neighbour's television — does not, and in a flat where that is a
    dozen devices they bury the one row that matters. Sorting them to the bottom
    was not enough: they still had to be read past, and each still offered a
    button. Folded away, the question this screen answers is "here is your
    station", not "which of these fourteen is it".
  */
  const discovered = list?.devices ?? [];
  const stations = discovered.filter((found) => found.likelyStation);
  const others = discovered.filter((found) => !found.likelyStation);

  /** Advice for whichever transports are actually scanning. */
  const nothingYet = simulated
    ? 'The simulator discovers nothing: it has no radio to scan with.'
    : [
        list?.transports.some((t) => t.kind === 'ble' && t.running)
          ? 'Make sure the station is powered on and Bluetooth is enabled on it.'
          : null,
        list?.transports.some((t) => t.kind === 'mqtt' && t.running)
          ? 'For WiFi, point mqtt.sydpower.com at this machine and power-cycle the station.'
          : null,
      ]
        .filter(Boolean)
        .join(' ');

  /** One discovered device, with whatever it is you can do with it. */
  const deviceRow = (found: (typeof discovered)[number]) => (
    <DeviceRow
      name={found.name}
      detail={`${found.mac ?? found.id}${found.rssi !== undefined ? ` · ${found.rssi} dBm` : ''}`}
      icon={found.kind === 'mqtt' ? 'wifi' : 'bluetooth'}
      active={found.bound}
      action={
        found.bound ? (
          <Button
            size="$2"
            disabled={busy || !ownerOf(found.id)}
            onPress={() => {
              const owner = ownerOf(found.id);
              if (owner) void unbind(owner);
            }}
          >
            Unbind
          </Button>
        ) : !target ? (
          /*
            Nothing to bind to. This used to be a disabled Bind button, which on
            the web does not even change the cursor — it just failed to respond.
            The way out is to add a device, and the card directly above this list
            says so and offers it; repeating that button on all thirty rows would
            imply each one leads somewhere different. So the rows stay
            informational, which is still worth reading: seeing the station in
            range is how you know the radio is working before you add anything.
          */
          null
        ) : (
          <Button
            size="$2"
            backgroundColor={found.likelyStation ? '$accent' : undefined}
            color={found.likelyStation ? '$background' : undefined}
            disabled={busy}
            onPress={() => void bind(target, found.id)}
          >
            {found.likelyStation ? 'Bind' : 'Try anyway'}
          </Button>
        )
      }
    />
  );

  return (
    <>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}

      {/*
        Which radio this server actually has.

        The transport is fixed when the server process starts, and nothing on
        this screen can change it — so a server started for WiFi will never
        discover a Bluetooth station no matter how long you watch the empty
        list. Saying which one is running, and naming the command that starts
        the other, is the difference between that and a screen that looks
        broken.
      */}
      {list && !list.transports.some((t) => t.kind === 'ble' && t.running) ? (
        <Card borderColor="$warning" gap="$2">
          <XStack alignItems="center" gap="$2">
            <Feather name={simulated ? 'cpu' : 'bluetooth'} size={15} color={theme.warning?.val} />
            <Text fontSize={14} fontWeight="700" color="$warning">
              {simulated ? 'This server is running the simulator' : 'This server has no Bluetooth'}
            </Text>
          </XStack>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            {simulated
              ? 'It is not talking to real hardware, so nothing will be discovered here.'
              : (list.transports.find((t) => t.kind === 'ble')?.error ??
                'It was not started with the Bluetooth transport, so it never scans for stations — that is why none appear below.')}
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            Restart it with{' '}
            <Text fontFamily="$mono" color="$color">
              npm run dev:device
            </Text>{' '}
            to run Bluetooth and WiFi together. To use Bluetooth from this{' '}
            {Platform.OS === 'web' ? 'browser' : 'phone'} instead, no server is involved at all —
            switch Connection to This device.
          </Text>
        </Card>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Link</SectionLabel>
        <Card inset>
          {/*
            Transports run together, so this lists them rather than naming one.
            Which radio a *station* uses is on its own row below.
          */}
          <Row
            title="Transports"
            subtitle="What this server can reach hardware with"
            accessory={
              <Text fontSize={15} fontWeight="700" color="$color">
                {(list?.transports ?? []).length === 0
                  ? '—'
                  : list!.transports
                      .map((t) =>
                        `${TRANSPORT_LABEL[t.kind] ?? t.kind}${t.running ? '' : ' (failed)'}`
                      )
                      .join(', ')}
              </Text>
            }
          />
          <RowSeparator />
          {/*
            One row per saved station, each naming its own device.

            This was a single "Bound station" row showing whichever session the
            server happened to list first — which reads as "the" station even
            when you own three, and would show one of them holding a link while
            the others looked like they had none.
          */}
          {(list?.links ?? []).length === 0 ? (
            <Row title="Bound stations" subtitle="No power station has been added yet" />
          ) : (
            (list?.links ?? []).map((entry) => (
              <Row
                key={entry.deviceId}
                title={entry.name}
                subtitle={entry.refusal ?? entry.stationId ?? 'Not bound to a station yet'}
                accessory={
                  <XStack alignItems="center" gap="$2">
                    <YStack
                      width={8}
                      height={8}
                      borderRadius={999}
                      backgroundColor={entry.connected ? '$success' : '$muted'}
                    />
                    <Text fontSize={13} color="$muted">
                      {entry.connected ? 'live' : 'no data'}
                    </Text>
                  </XStack>
                }
              />
            ))
          )}
          <RowSeparator />
          <Row
            title="Auto-bind"
            subtitle={
              list?.autoBind
                ? 'Adopts the first identified station; retries with backoff'
                : 'Disabled — bind manually below'
            }
          />
          {list?.lastError ? (
            <>
              <RowSeparator />
              <Row
                title="Last connect error"
                subtitle={list.lastError}
                accessory={
                  <Text fontSize={13} color="$muted">
                    {list.attempts ?? 0} tries
                  </Text>
                }
              />
            </>
          ) : null}
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Discovered</SectionLabel>

        {/*
          Binding needs a subject. With one saved station this says which, so
          nothing is implied; with several it is a choice, because the server
          will not guess and neither should this screen.
        */}
        {links.length === 0 ? (
          <Card gap="$3">
            <Text fontSize={12} color="$muted" lineHeight={18}>
              A link belongs to a saved device, so there is nothing to bind these to yet. Add the
              station under Your devices and it becomes somewhere to bind.
            </Text>
            <Button
              size="$3"
              backgroundColor="$accent"
              color="$background"
              icon={<Feather name="plus" size={15} color={theme.background?.val} />}
              onPress={() => {
                haptic();
                router.push('/add-device');
              }}
            >
              Add a power station
            </Button>
          </Card>
        ) : links.length === 1 ? (
          <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
            Binding attaches the station to {links[0]!.name}.
          </Text>
        ) : (
          <Card inset>
            <ModeRow
              title="Bind to"
              subtitle="Which of your saved stations this link belongs to"
              value={target ?? ''}
              options={links.map((entry) => ({ value: entry.deviceId, label: entry.name }))}
              onChange={setChosen}
            />
          </Card>
        )}

        <Card inset>
          {!list ? (
            <YStack padding="$5" alignItems="center">
              <Spinner color="$accent" />
            </YStack>
          ) : (
            <>
              {stations.length === 0 ? (
                <Row
                  title={
                    discovered.length === 0 ? 'Nothing found yet' : 'No power station among them'
                  }
                  subtitle={
                    discovered.length === 0
                      ? nothingYet
                      : `Nothing in range announced itself as a power station. ${nothingYet}`
                  }
                />
              ) : (
                stations.map((found, index) => (
                  <YStack key={found.id}>
                    {index > 0 ? <RowSeparator /> : null}
                    {deviceRow(found)}
                  </YStack>
                ))
              )}

              {others.length > 0 ? (
                <>
                  <RowSeparator />
                  <Pressable
                    onPress={() => {
                      haptic();
                      setShowOther((open) => !open);
                    }}
                  >
                    <Row
                      title={
                        others.length === 1
                          ? '1 other Bluetooth device'
                          : `${others.length} other Bluetooth devices`
                      }
                      subtitle={
                        showOther
                          ? 'None of these announced itself as a power station.'
                          : 'Open this only if your station is missing above.'
                      }
                      accessory={
                        <Feather
                          name={showOther ? 'chevron-up' : 'chevron-down'}
                          size={16}
                          color={theme.muted?.val}
                        />
                      }
                    />
                  </Pressable>

                  {showOther
                    ? others.map((found) => (
                        <YStack key={found.id} opacity={0.65}>
                          <RowSeparator />
                          {deviceRow(found)}
                        </YStack>
                      ))
                    : null}
                </>
              ) : null}
            </>
          )}
        </Card>
      </YStack>
    </>
  );
}

/** The app's own Bluetooth link: chooser or scan, connect, and the write guard. */
function DirectLink({ direct }: { direct: ReturnType<typeof useDirectLink>['direct'] }) {
  const { support, devices, boundId, connected, readOnly, busy, scanning, error } = direct;
  const { remembered, resuming } = direct;
  const isWeb = Platform.OS === 'web';
  const theme = useTheme();

  /** The station's advertised name beats an opaque per-origin id in the UI. */
  const boundName =
    devices.find((device) => device.id === boundId)?.name ??
    (remembered?.id === boundId ? remembered.name : null);

  if (!support.supported) {
    return (
      <Card borderColor="$warning" gap="$2">
        <XStack alignItems="center" gap="$2">
          <Feather name="bluetooth" size={15} color={theme.warning?.val} />
          <Text fontSize={14} fontWeight="700" color="$warning">
            Direct Bluetooth is not available here
          </Text>
        </XStack>
        <Text fontSize={12} color="$muted" lineHeight={18}>
          {support.reason}
        </Text>
      </Card>
    );
  }

  return (
    <>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Link</SectionLabel>
        <Card inset>
          <Row
            title="Transport"
            subtitle="Frames go straight from this app to the station"
            accessory={
              <Text fontSize={15} fontWeight="700" color="$color">
                {support.label}
              </Text>
            }
          />
          <RowSeparator />
          <Row
            title="Connected station"
            subtitle={boundName ?? boundId ?? 'None'}
            accessory={
              <XStack alignItems="center" gap="$2">
                {resuming ? <Spinner size="small" color="$accent" /> : null}
                <YStack
                  width={8}
                  height={8}
                  borderRadius={999}
                  backgroundColor={connected ? '$success' : '$muted'}
                />
                <Text fontSize={13} color="$muted">
                  {connected ? 'live' : resuming ? 'reconnecting' : 'not connected'}
                </Text>
              </XStack>
            }
          />
          <RowSeparator />
          {/*
            Writes are refused by default, exactly as the server's hardware modes
            are. The guard is in the shared StationClient, not in this screen —
            this switch only asks for it.
          */}
          <ToggleRow
            title="Allow writes"
            subtitle={
              readOnly
                ? 'Read-only. Nothing can change on the station.'
                : 'Settings and ports can be changed. Writing an undocumented register can destroy the station — the whitelist still applies.'
            }
            checked={!readOnly}
            onCheckedChange={(next) => direct.setReadOnly(!next)}
          />
        </Card>
      </YStack>

      {/*
        The station you were last on, offered first. A reload reconnects to it
        on its own where the platform allows that; where it doesn't — a browser
        that didn't keep the Bluetooth permission — this is the one tap back,
        and the chooser it opens is filtered to this station alone.
      */}
      {remembered && !connected ? (
        <YStack gap="$2">
          <SectionLabel>Last used</SectionLabel>
          <Card inset>
            <Row
              title={remembered.name}
              subtitle={
                resuming
                  ? 'Reconnecting…'
                  : `Connected ${formatAgo(remembered.at)}${
                      remembered.autoConnect ? '' : ' · you disconnected this one'
                    }`
              }
              accessory={
                resuming ? (
                  <Spinner size="small" color="$accent" />
                ) : (
                  <Button
                    size="$2"
                    backgroundColor="$accent"
                    color="$background"
                    disabled={busy}
                    onPress={() => {
                      haptic();
                      direct.reconnect();
                    }}
                  >
                    Reconnect
                  </Button>
                )
              }
            />
            <RowSeparator />
            <Row
              title="Forget this station"
              subtitle="Stops offering it here and on the next launch"
              accessory={
                <Button size="$2" disabled={busy || resuming} onPress={() => direct.forget()}>
                  Forget
                </Button>
              }
            />
          </Card>
        </YStack>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>
          {remembered && !connected
            ? 'Another station'
            : isWeb
              ? 'Choose a station'
              : 'Nearby'}
        </SectionLabel>
        <Card inset>
          <YStack padding="$4" gap="$3">
            <Text fontSize={12} color="$muted" lineHeight={18}>
              {isWeb
                ? 'The browser picks the device, not the page: this opens its Bluetooth chooser. Close the vendor app first — these stations accept one connection at a time.'
                : 'Close the vendor app first — these stations accept one connection at a time, and while a phone holds it the vendor services are invisible.'}
            </Text>
            <XStack gap="$2">
              <Button
                flex={1}
                size="$3"
                backgroundColor="$accent"
                color="$background"
                disabled={busy}
                icon={busy ? undefined : <Feather name="bluetooth" size={15} />}
                onPress={() => {
                  haptic();
                  direct.pick();
                }}
              >
                {busy ? 'Working…' : isWeb ? 'Choose station' : scanning ? 'Scanning…' : 'Scan'}
              </Button>
              {isWeb ? (
                <Button
                  size="$3"
                  disabled={busy}
                  onPress={() => {
                    haptic();
                    direct.pick(true);
                  }}
                >
                  Show all
                </Button>
              ) : scanning ? (
                <Button size="$3" onPress={() => direct.stopScan()}>
                  Stop
                </Button>
              ) : null}
            </XStack>
          </YStack>

          {devices.length > 0 ? <RowSeparator /> : null}

          {[...devices]
            .sort((a, b) => Number(b.likelyStation) - Number(a.likelyStation))
            .map((found, index) => (
              <YStack key={found.id} opacity={found.likelyStation ? 1 : 0.55}>
                {index > 0 ? <RowSeparator /> : null}
                <DeviceRow
                  name={found.name}
                  detail={`${found.rssi !== undefined ? `${found.rssi} dBm · ` : ''}${
                    found.likelyStation ? 'identified as a station' : 'not identified as a station'
                  }`}
                  icon="bluetooth"
                  active={found.id === boundId}
                  action={
                    found.id === boundId ? (
                      <Button size="$2" disabled={busy} onPress={() => void direct.disconnect()}>
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        size="$2"
                        backgroundColor={found.likelyStation ? '$accent' : undefined}
                        color={found.likelyStation ? '$background' : undefined}
                        disabled={busy}
                        onPress={() => void direct.connect(found.id)}
                      >
                        Connect
                      </Button>
                    )
                  }
                />
              </YStack>
            ))}
        </Card>
      </YStack>
    </>
  );
}

/** One discovered device: what it is, how strong, and what you can do with it. */
function DeviceRow({
  name,
  detail,
  icon,
  active,
  action,
}: {
  name: string;
  detail: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  active: boolean;
  action: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
    >
      <YStack flex={1} gap={2}>
        <XStack alignItems="center" gap="$2">
          <Feather name={icon} size={13} color={active ? theme.success?.val : theme.muted?.val} />
          <Text fontSize={15} fontWeight="600" color="$color" numberOfLines={1}>
            {name}
          </Text>
        </XStack>
        <Text fontSize={12} color="$muted" numberOfLines={1}>
          {detail}
        </Text>
      </YStack>
      {action}
    </XStack>
  );
}
