import { useCallback, useMemo, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, isOnline, LINK_KINDS } from '@kraftverk/api-client';
import type { AttributeSpec, ConfigSchema, ConnectionView, DeviceView, LinkView, Value } from '@kraftverk/api-client';
import {
  attributeMeaning,
  attributesOf,
  capabilitiesOf,
  capabilitySpec,
  keepsHistory,
  MAIN_PART,
  partsOf,
  quantityOf,
  type CapabilityName,
  type ConfigValues,
  type Part,
} from '@kraftverk/device-sdk';
import {
  Card,
  DeviceCard,
  Row,
  RowSeparator,
  SchemaForm,
  SectionLabel,
  ToggleRow,
  formatValue,
  haptic,
  readingFor,
  useWriteGate,
} from '@kraftverk/ui';

import { MeasurementChart } from '../../components/MeasurementChart';
import { Pressable } from '../../components/Pressable';
import { confirmAction } from '../../lib/confirm';
import { featherName } from '../../lib/icons';
import { useDevices } from '../../state/DevicesProvider';

/**
 * What every device gets for free.
 *
 * Written against its description: a section for each of its parts, the
 * controls from the commands its parts take, the rows from what they report,
 * the settings form from the attributes it can be told, and its connections
 * and links from the data model. Nothing here knows what a power station is —
 * a plug added next year lands on these panels with no code written for it.
 */

export function DeviceIcon({ device, size = 16 }: { device: DeviceView; size?: number }) {
  const theme = useTheme();
  return <Feather name={featherName(device.meta.icon, 'zap')} size={size} color={isOnline(device.health) ? theme.accent?.val : theme.muted?.val} />;
}

export function Overview({ device }: { device: DeviceView }) {
  return (
    <DeviceCard
      device={{ name: device.name, subtitle: device.meta.name, health: device.health, attributes: attributesOf(device.description, MAIN_PART), readings: device.readings }}
      icon={<DeviceIcon device={device} />}
    />
  );
}

/** What a part is called on a screen: the device's name for its main part, its own label otherwise. */
const partTitle = (device: DeviceView, part: Part) => (part.id === MAIN_PART ? device.name : part.label);

// --- controls -----------------------------------------------------------------

/** One switch a part takes: which command, which argument, and the on/off attribute it moves. */
type Toggle = { part: Part; capability: CapabilityName; command: string; argument: string; attribute: AttributeSpec };

/**
 * Every on/off a device's parts can be switched through: each command a part's
 * capability takes whose argument sets an on/off attribute it reports.
 */
function togglesOf(device: DeviceView): Toggle[] {
  return partsOf(device.description, device.name).flatMap((part) =>
    capabilitiesOf(device.description, part.id).flatMap((capability) =>
      Object.entries(capabilitySpec(capability).commands).flatMap(([command, spec]) =>
        Object.entries(spec.sets).flatMap(([argument, attributeName]) => {
          const means = capabilitySpec(capability).attributes[attributeName]?.means;
          const attribute = means ? attributeMeaning(device.description, part.id, means) : null;
          return attribute && attribute.value.type === 'boolean' && spec.args[argument]?.type === 'boolean' ? [{ part, capability, command, argument, attribute }] : [];
        })
      )
    )
  );
}

/**
 * What this device can be told to do. Every control is a command to one of
 * its parts through the holder's gateway — which asks the person to confirm
 * when it matters, and says why — so a tap here has exactly a manual switch's
 * authority.
 */
export function Controls({ device }: { device: DeviceView }) {
  const { actionsFor } = useDevices();
  const [gate, writes] = useWriteGate<string>();
  const [error, setError] = useState<string | null>(null);
  const toggles = useMemo(() => togglesOf(device), [device]);

  const run = useCallback(
    async (toggle: Toggle, value: boolean) => {
      setError(null);
      haptic();
      try {
        await gate.run({ [toggle.attribute.key]: value }, async () => {
          const result = await actionsFor(device).command({
            part: toggle.part.id,
            capability: toggle.capability,
            command: toggle.command,
            args: { [toggle.argument]: value },
            reason: `${partTitle(device, toggle.part)} from the device screen`,
          });
          if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
          if (result.outcome === 'unverified') setError(result.detail);
        });
      } catch (err) {
        setError(describeError(err) || 'That did not work');
      }
    },
    [actionsFor, device, gate]
  );

  if (toggles.length === 0) return null;
  const unavailable = !isOnline(device.health);

  return (
    <YStack gap="$2">
      <SectionLabel>Controls</SectionLabel>
      <Card inset>
        {toggles.map((toggle, index) => {
          const reading = readingFor(device.readings, toggle.attribute.key);
          const pending = writes.pending.has(toggle.attribute.key);
          const value = pending ? writes.pending.get(toggle.attribute.key) : reading?.value;
          return (
            <YStack key={`${toggle.part.id}:${toggle.attribute.key}`}>
              {index > 0 ? <RowSeparator /> : null}
              <ToggleRow
                title={toggle.part.id === MAIN_PART ? toggle.attribute.label : toggle.part.label}
                subtitle={toggle.attribute.consequence}
                checked={value === true}
                disabled={unavailable}
                pending={pending}
                onCheckedChange={(next) => void run(toggle, next)}
              />
            </YStack>
          );
        })}
      </Card>
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}

// --- readings -----------------------------------------------------------------

/** Everything each part reports, part by part, and what it last said. Settings are elsewhere. */
export function Readings({ device }: { device: DeviceView }) {
  const sections = partsOf(device.description, device.name)
    .map((part) => ({ part, attributes: attributesOf(device.description, part.id).filter((attribute) => attribute.access !== 'write') }))
    .filter((section) => section.attributes.length > 0);
  if (sections.length === 0) return null;
  return (
    <YStack gap="$3">
      {sections.map(({ part, attributes }) => (
        <YStack key={part.id} gap="$2">
          <SectionLabel>{part.id === MAIN_PART ? 'Readings' : part.label}</SectionLabel>
          <Card inset>
            {attributes.map((spec, index) => (
              <YStack key={spec.key}>
                {index > 0 ? <RowSeparator /> : null}
                <Row
                  title={spec.label}
                  accessory={
                    <Text fontSize={15} fontWeight="700" color={spec.category === 'diagnostic' ? '$muted' : '$color'}>
                      {formatValue(spec, readingFor(device.readings, spec.key)?.value ?? null)}
                    </Text>
                  }
                />
              </YStack>
            ))}
          </Card>
        </YStack>
      ))}
    </YStack>
  );
}

// --- history ------------------------------------------------------------------

/**
 * One chart, and a way to point it at any number the device keeps. The server
 * records every attribute its description says to keep — whoever holds it — so
 * the picker is simply that list. Local mode keeps no history, and says nothing.
 */
export function History({ device }: { device: DeviceView }) {
  const { history } = useDevices();
  const chartable = device.description.attributes.filter(
    (attribute) => attribute.value.type === 'number' && keepsHistory(attribute) && quantityOf(attribute) !== 'state'
  );
  const [key, setKey] = useState<string | null>(null);
  const selected: AttributeSpec | undefined =
    chartable.find((spec) => spec.key === key) ?? chartable.find((spec) => spec.category === 'primary') ?? chartable[0];
  if (!history || !selected) return null;
  const parts = new Map(partsOf(device.description, device.name).map((part) => [part.id, part]));
  const label = (spec: AttributeSpec) => (spec.part && spec.part !== MAIN_PART && !spec.label.startsWith(parts.get(spec.part)?.label ?? '') ? `${parts.get(spec.part)?.label}: ${spec.label}` : spec.label);

  return (
    <YStack gap="$2">
      <SectionLabel>History</SectionLabel>
      <Card gap="$3">
        <XStack flexWrap="wrap" gap="$1.5">
          {chartable.map((spec) => (
            <Text
              key={spec.key}
              role="radio"
              tabIndex={0}
              aria-checked={spec.key === selected.key}
              fontSize={12}
              fontWeight="600"
              paddingHorizontal="$2.5"
              paddingVertical="$1.5"
              borderRadius="$3"
              backgroundColor={spec.key === selected.key ? '$accent' : '$backgroundPress'}
              color={spec.key === selected.key ? '$background' : '$muted'}
              cursor="pointer"
              pressStyle={{ opacity: 0.7 }}
              focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
              onPress={() => {
                haptic();
                setKey(spec.key);
              }}
            >
              {label(spec)}
            </Text>
          ))}
        </XStack>
        <MeasurementChart deviceId={device.id} measurement={selected} />
      </Card>
    </YStack>
  );
}

// --- settings -----------------------------------------------------------------

/** The attributes a device can be told, as the form language draws them: one form per section. */
function settingsForms(device: DeviceView): { section: string; schema: ConfigSchema; keys: string[] }[] {
  const writable = device.description.attributes.filter((attribute) => attribute.access === 'write');
  const sections = [...new Set(writable.map((attribute) => attribute.section ?? 'Settings'))];
  return sections.map((section) => {
    const inSection = writable.filter((attribute) => (attribute.section ?? 'Settings') === section);
    return {
      section,
      keys: inSection.map((attribute) => attribute.key),
      schema: {
        fields: Object.fromEntries(
          inSection.map((attribute) => [
            attribute.key,
            { ...attribute.value, title: attribute.label, ...(attribute.description ? { description: attribute.description } : {}) },
          ])
        ),
      },
    };
  });
}

/**
 * The device's own settings: the attributes its description says can be
 * written, grouped as it groups them, with what it reports now. Edits are held
 * until Save: writing a register per keystroke would put the hardware through a
 * dozen writes to reach one value.
 */
export function GenericSettings({ device }: { device: DeviceView }) {
  const { actionsFor } = useDevices();
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forms = useMemo(() => settingsForms(device), [device]);
  const dangerous = device.description.attributes.filter((attribute) => attribute.access === 'write' && attribute.dangerous);

  if (forms.length === 0) return null;
  const values = Object.fromEntries(forms.flatMap((form) => form.keys).map((key) => [key, readingFor(device.readings, key)?.value ?? undefined]));
  const known = Object.values(values).some((value) => value !== undefined && value !== null);
  const pending = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // The reply is a readback: one setting can move another.
      const result = await actionsFor(device).write(draft);
      if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
      if (result.outcome === 'unverified') setError(result.detail);
      setDraft({});
    } catch (err) {
      setError(describeError(err) || 'That write was refused');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3">
      {dangerous.length > 0 ? (
        <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
          {dangerous.length === 1 ? 'One setting here can' : `${dangerous.length} settings here can`} damage the hardware if set wrongly. The device
          says which; their descriptions explain what happens.
        </Text>
      ) : null}
      {forms.map((form) => (
        <YStack key={form.section} gap="$2">
          <SectionLabel>{form.section}</SectionLabel>
          <Card inset>
            {!known ? (
              <YStack padding="$5" alignItems="center">
                {isOnline(device.health) ? <Spinner color="$accent" /> : <Text fontSize={13} color="$muted" textAlign="center">{device.health.detail}</Text>}
              </YStack>
            ) : (
              <SchemaForm
                schema={form.schema}
                values={{ ...(values as ConfigValues), ...(draft as ConfigValues) }}
                disabled={busy || !isOnline(device.health)}
                onChange={(name, value) => setDraft((current) => ({ ...current, [name]: value as Value }))}
              />
            )}
          </Card>
        </YStack>
      ))}
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
      {pending ? (
        <XStack gap="$2">
          <Button flex={1} size="$3" disabled={busy} onPress={() => setDraft({})}>
            Discard
          </Button>
          <Button
            flex={1}
            size="$3"
            backgroundColor="$accent"
            color="$background"
            disabled={busy}
            onPress={() => {
              haptic();
              void save();
            }}
          >
            {busy ? 'Writing…' : 'Save'}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
}

// --- connections ------------------------------------------------------------------

const heldByLabel = (connection: ConnectionView, clientId: string | null) =>
  connection.heldBy.kind === 'server'
    ? 'through your server'
    : connection.heldBy.id === clientId || connection.heldBy.id === 'this-app'
      ? 'from this app'
      : `from ${connection.heldBy.name}`;

/**
 * How this device is reached (docs/DATA-MODEL.md §4): one connection in use,
 * the rest standing by in order. Another way to reach it is added through the
 * same steps as the device itself, and must reach this device.
 */
export function Connections({ device }: { device: DeviceView }) {
  const { prefer, removeConnection, runtime } = useDevices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  const act = async (work: () => Promise<void>) => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const ordered = [...device.connections].sort((a, b) => a.priority - b.priority);

  return (
    <YStack gap="$2">
      <SectionLabel>Connections</SectionLabel>
      <Card inset>
        {ordered.length === 0 ? (
          <Row title="Nothing can reach this device" subtitle="Add a way to reach it" />
        ) : (
          ordered.map((connection, index) => (
            <YStack key={connection.id}>
              {index > 0 ? <RowSeparator /> : null}
              <YStack paddingHorizontal="$4" paddingVertical="$3" gap="$2">
                <XStack alignItems="center" justifyContent="space-between" gap="$2">
                  <YStack flex={1} gap={2}>
                    <Text fontSize={15} fontWeight="600" color="$color">
                      {connection.methodLabel}, {heldByLabel(connection, runtime.clientId)}
                    </Text>
                    <Text fontSize={12} color="$muted">
                      {connection.inUse
                        ? 'In use'
                        : connection.lastConnectedAt
                          ? `Standing by · last connected ${new Date(connection.lastConnectedAt).toLocaleString()}`
                          : 'Standing by'}
                      {` · ${connection.address}`}
                      {connection.secrets.length ? ` · ${connection.secrets.join(', ')} kept` : ''}
                    </Text>
                  </YStack>
                  {connection.inUse ? <Feather name="check-circle" size={16} color={theme.success?.val} /> : null}
                </XStack>
                {ordered.length > 1 ? (
                  <XStack gap="$2">
                    {index > 0 ? (
                      <Button size="$2" disabled={busy} onPress={() => void act(() => prefer(device, connection))}>
                        Make preferred
                      </Button>
                    ) : null}
                    <Button
                      size="$2"
                      disabled={busy}
                      onPress={() =>
                        void act(async () => {
                          if (await confirmAction('Remove this connection?', `${device.name} will no longer be reached ${connection.methodLabel.toLowerCase()}, ${heldByLabel(connection, runtime.clientId)}.`, 'Remove')) {
                            await removeConnection(device, connection);
                          }
                        })
                      }
                    >
                      Remove
                    </Button>
                  </XStack>
                ) : null}
              </YStack>
            </YStack>
          ))
        )}
        <RowSeparator />
        <Pressable onPress={() => router.push(`/add-device?attach=${encodeURIComponent(device.id)}&type=${encodeURIComponent(device.typeId)}`)}>
          <Row title="Add another way to reach it" accessory={<Feather name="plus" size={16} color={theme.muted?.val} />} />
        </Pressable>
      </Card>
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}

// --- links ------------------------------------------------------------------------

/**
 * Facts about the house (docs/ARCHITECTURE.md §4.4): this plug feeds that
 * station. Offered only between devices a link kind fits.
 */
export function Links({ device }: { device: DeviceView }) {
  const { devices, addLink, removeLink } = useDevices();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const theme = useTheme();

  const candidates = Object.entries(LINK_KINDS).flatMap(([kind, spec]) => {
    const asSource = device.capabilities.includes(spec.from)
      ? devices.filter((other) => other.id !== device.id && other.capabilities.includes(spec.to)).map((other) => ({ kind, role: 'source' as const, other }))
      : [];
    const asTarget = device.capabilities.includes(spec.to)
      ? devices.filter((other) => other.id !== device.id && other.capabilities.includes(spec.from)).map((other) => ({ kind, role: 'target' as const, other }))
      : [];
    return [...asSource, ...asTarget];
  });
  const linked = (kind: string, role: 'source' | 'target', otherId: string) =>
    device.links.some((link) => link.kind === kind && link.role === role && link.other.id === otherId);

  if (device.links.length === 0 && candidates.length === 0) return null;

  const act = async (work: () => Promise<void>) => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const sentence = (link: { kind: string; role: 'source' | 'target' }, otherName: string) => {
    const verb = (LINK_KINDS as Record<string, { verb: string }>)[link.kind]?.verb ?? link.kind;
    return link.role === 'source' ? `${capitalise(verb)} ${otherName}` : `${otherName} ${verb} it`;
  };

  return (
    <YStack gap="$2">
      <SectionLabel>How it fits the house</SectionLabel>
      <Card inset>
        {device.links.map((link: LinkView, index) => (
          <YStack key={link.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Row
              title={sentence(link, link.other.name)}
              accessory={
                <Button size="$2" disabled={busy} onPress={() => void act(() => removeLink(link))}>
                  Remove
                </Button>
              }
            />
          </YStack>
        ))}
        {candidates
          .filter((candidate) => !linked(candidate.kind, candidate.role, candidate.other.id))
          .map((candidate, index) => (
            <YStack key={`${candidate.kind}-${candidate.role}-${candidate.other.id}`}>
              {index > 0 || device.links.length > 0 ? <RowSeparator /> : null}
              <Pressable
                onPress={() =>
                  void act(() =>
                    candidate.role === 'source' ? addLink(candidate.kind, device.id, candidate.other.id) : addLink(candidate.kind, candidate.other.id, device.id)
                  )
                }
              >
                <Row
                  title={sentence(candidate, candidate.other.name)}
                  subtitle={(LINK_KINDS as Record<string, { description: string }>)[candidate.kind]?.description}
                  accessory={<Feather name="plus" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            </YStack>
          ))}
      </Card>
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// --- manage -----------------------------------------------------------------------

/**
 * Its name, and removing it. Removing keeps its history on the server, so
 * adding the same device again can bring it back; in local mode there is no
 * history, and it is simply gone.
 */
export function Manage({ device }: { device: DeviceView }) {
  const { rename, remove, mode } = useDevices();
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  const dirty = name.trim() !== device.name && name.trim().length > 0;

  const removeIt = async () => {
    haptic();
    const message =
      mode === 'server'
        ? `${device.name} leaves your list, and its connections go. Its history is kept: add the same device again to bring it back.`
        : `${device.name} and how it is reached are deleted from this app.`;
    if (!(await confirmAction('Remove this device?', message, 'Remove'))) return;
    setBusy(true);
    setError(null);
    try {
      await remove(device.id);
      router.replace('/');
    } catch (err) {
      setError(describeError(err) || 'It could not be removed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Manage</SectionLabel>
      <Card inset>
        <YStack padding="$4" gap="$2">
          <Text fontSize={15} fontWeight="600" color="$color">
            Name
          </Text>
          <XStack gap="$2">
            <Input flex={1} size="$3" value={name} maxLength={60} onChangeText={setName} backgroundColor="$background" borderColor="$borderColor" />
            {dirty ? (
              <Button
                size="$3"
                backgroundColor="$accent"
                color="$background"
                disabled={busy}
                onPress={() => {
                  haptic();
                  setBusy(true);
                  setError(null);
                  rename(device.id, name.trim())
                    .catch((err: unknown) => setError(describeError(err) || 'That name could not be saved'))
                    .finally(() => setBusy(false));
                }}
              >
                Save
              </Button>
            ) : null}
          </XStack>
          <Text fontSize={12} color="$muted" lineHeight={17}>
            Yours alone: changing it changes nothing but the label. {device.meta.name}
            {device.identity ? ` · ${device.identity}` : ''}
          </Text>
        </YStack>
        <RowSeparator />
        <Row
          title="Remove this device"
          subtitle={mode === 'server' ? 'Its history is kept, to bring back or delete later' : 'Deleted from this app'}
          accessory={
            <Button size="$2" disabled={busy} borderColor="$danger" icon={<Feather name="trash-2" size={13} color={theme.danger?.val} />} onPress={() => void removeIt()}>
              Remove
            </Button>
          }
        />
      </Card>
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}
