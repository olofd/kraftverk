import { useCallback, useEffect, useMemo, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { isActuator, type CapabilityName } from '@kraftverk/plugin-sdk';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '@kraftverk/ui';
import { Row, RowSeparator, ToggleRow } from '@kraftverk/ui';
import { isComplete, SchemaForm } from '@kraftverk/ui';
import { Screen } from '../../src/components/Screen';
import {
  describeError,
  fetchGrid,
  fetchPluginConfig,
  fetchPlugins,
  patchPluginConfig,
  runSetupAction,
  setPluginEnabled,
  setPluginGrant,
  setPluginProvider,
  switchGridRelay,
  testPlugin,
} from '@kraftverk/api-client';
import { formatAgo } from '@kraftverk/ui';
import { haptic } from '@kraftverk/ui';
import type {
  ConfigSchema,
  ConfigValues,
  GridStatus,
  PluginConfig,
  PluginList,
  PluginSummary,
  SetupActionResult,
} from '@kraftverk/api-client';
import { panelFor } from '../../src/plugins/panels';

/**
 * Extensions: what is installed, and getting each one working.
 *
 * The screen knows nothing about any particular plugin. Cards, settings forms,
 * commissioning helpers and the setup wizard are all rendered from what a
 * plugin declares, so a weather source added later arrives with a working
 * screen and no changes here. The only plugin-specific thing in the app is the
 * optional panel registry, and a plugin without a panel loses nothing.
 */

const KIND_LABELS: Record<string, string> = {
  'grid-relay': 'Grid relay',
  weather: 'Weather',
  'pv-forecast': 'Solar forecast',
  price: 'Electricity price',
  'home-automation': 'Home automation',
};

const STATUS_TINT: Record<string, string> = {
  healthy: '$success',
  degraded: '$warning',
  failed: '$danger',
  'needs-configuration': '$warning',
  starting: '$muted',
  installed: '$muted',
  disabled: '$muted',
};

const STATUS_LABEL: Record<string, string> = {
  healthy: 'Working',
  degraded: 'Struggling',
  failed: 'Not working',
  'needs-configuration': 'Needs setting up',
  starting: 'Starting',
  installed: 'Not set up',
  disabled: 'Off',
};

export default function ExtensionsScreen() {
  const [list, setList] = useState<PluginList | null>(null);
  const [grid, setGrid] = useState<GridStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [plugins, gridState] = await Promise.all([fetchPlugins(signal), fetchGrid(signal)]);
      setList(plugins);
      setGrid(gridState);
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [load]);

  const plugin = list?.plugins.find((candidate) => candidate.id === selected);

  if (plugin) {
    return (
      <PluginSetup
        plugin={plugin}
        grid={grid}
        isActiveProvider={list?.activeProviders.gridRelay === plugin.id}
        onBack={() => setSelected(null)}
        onChanged={() => void load()}
      />
    );
  }

  const byKind = new Map<string, PluginSummary[]>();
  for (const candidate of list?.plugins ?? []) {
    byKind.set(candidate.kind, [...(byKind.get(candidate.kind) ?? []), candidate]);
  }

  return (
    <Screen title="Extensions" subtitle="Smart plugs, weather and other optional pieces">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}

      {list && !list.secretsEncrypted ? (
        <Card borderColor="$warning" gap="$2">
          <Text fontSize={14} fontWeight="700" color="$warning">
            Secrets are stored unencrypted
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            Keys and tokens sit in plain text in the server&apos;s database, protected only by file
            permissions. Set KRAFTVERK_SECRET_KEY in the server&apos;s environment to encrypt them.
          </Text>
        </Card>
      ) : null}

      {!list ? (
        <Card alignItems="center" paddingVertical="$6">
          <Spinner color="$accent" />
        </Card>
      ) : list.plugins.length === 0 ? (
        <Card gap="$2">
          <Text fontSize={14} fontWeight="700" color="$color">
            Nothing installed
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            Extensions are npm packages under packages/plugins. The station works fully without any.
          </Text>
        </Card>
      ) : (
        [...byKind.entries()].map(([kind, plugins]) => (
          <YStack key={kind} gap="$2">
            <SectionLabel>{KIND_LABELS[kind] ?? kind}</SectionLabel>
            <Card inset>
              {plugins.map((candidate, index) => (
                <YStack key={candidate.id}>
                  {index > 0 ? <RowSeparator /> : null}
                  <PluginCard plugin={candidate} onPress={() => setSelected(candidate.id)} />
                </YStack>
              ))}
            </Card>
          </YStack>
        ))
      )}
    </Screen>
  );
}

/** One plugin in the list: what it is, whether it works, and what it knows. */
function PluginCard({ plugin, onPress }: { plugin: PluginSummary; onPress: () => void }) {
  const theme = useTheme();
  const tint = STATUS_TINT[plugin.status] ?? '$muted';
  const age = plugin.health.dataAgeMs;

  return (
    <XStack
      alignItems="center"
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
      cursor="pointer"
      pressStyle={{ opacity: 0.7 }}
      onPress={() => {
        haptic();
        onPress();
      }}
    >
      <YStack
        width={34}
        height={34}
        borderRadius={999}
        alignItems="center"
        justifyContent="center"
        backgroundColor="$backgroundPress"
      >
        <Feather
          name={plugin.icon as React.ComponentProps<typeof Feather>['name']}
          size={16}
          color={theme.muted?.val}
        />
      </YStack>

      <YStack flex={1} gap={2}>
        <Text fontSize={15} fontWeight="600" color="$color">
          {plugin.name}
        </Text>
        {/*
          Facts come from the plugin, so this line reads "Relay: on · 240 W" for
          a plug and "Now: 4 °C · Tomorrow: 1.9 kWh" for a weather source
          without this component knowing which is which.
        */}
        <Text fontSize={12} color="$muted" numberOfLines={1}>
          {plugin.health.facts?.length
            ? plugin.health.facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')
            : (plugin.error ?? plugin.description)}
        </Text>
      </YStack>

      <YStack alignItems="flex-end" gap={2}>
        <XStack alignItems="center" gap="$2">
          <YStack width={7} height={7} borderRadius={999} backgroundColor={tint} />
          <Text fontSize={12} color="$muted">
            {STATUS_LABEL[plugin.status] ?? plugin.status}
          </Text>
        </XStack>
        {age !== undefined && plugin.status === 'healthy' ? (
          <Text fontSize={11} color="$muted">
            {age < 60_000 ? `${Math.round(age / 1000)}s ago` : formatAgo(new Date(Date.now() - age).toISOString())}
          </Text>
        ) : null}
      </YStack>
    </XStack>
  );
}

/**
 * The setup wizard.
 *
 * Steps are derived from the plugin's declarations and its current state rather
 * than written down: a plug that can switch mains needs permission and an owner
 * for that resource, while a weather source needs neither and simply does not
 * see those steps.
 */
function PluginSetup({
  plugin,
  grid,
  isActiveProvider,
  onBack,
  onChanged,
}: {
  plugin: PluginSummary;
  grid: GridStatus | null;
  isActiveProvider: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<PluginConfig | null>(null);
  const [draft, setDraft] = useState<ConfigValues>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  /*
    Held here rather than inside the step, so a scan that took twelve seconds
    is not thrown away by collapsing the section it lives in.
  */
  const [actionInputs, setActionInputs] = useState<Record<string, ConfigValues>>({});
  const [actionResults, setActionResults] = useState<Record<string, SetupActionResult>>({});

  const load = useCallback(async () => {
    try {
      const next = await fetchPluginConfig(plugin.id);
      setConfig(next);
      setDraft(next.values);
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [plugin.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const actuators = plugin.capabilities.filter(isActuator);
  const granted = actuators.every((capability) => plugin.grants.includes(capability));
  const configured =
    config !== null && isComplete(config.schema, draft, config.secretsSet) && plugin.status !== 'needs-configuration';

  const steps = useMemo(() => {
    const list: { id: string; title: string; done: boolean; hint?: string }[] = [];

    if (plugin.setupActions.length > 0) {
      list.push({
        id: 'find',
        title: 'Find it',
        done: configured,
        hint: 'Helpers that fill the settings in for you',
      });
    }
    list.push({ id: 'configure', title: 'Settings', done: configured });
    list.push({ id: 'enable', title: 'Turn it on', done: plugin.enabled });
    list.push({
      id: 'verify',
      title: 'Check it works',
      done: plugin.status === 'healthy',
      hint: 'Reads from the device without changing anything',
    });
    if (actuators.length > 0) {
      list.push({
        id: 'permission',
        title: 'Permission to switch mains',
        done: granted,
        hint: 'Nothing can be switched until this is granted',
      });
    }
    if (plugin.kind === 'grid-relay') {
      list.push({
        id: 'provider',
        title: 'Use it as the grid relay',
        done: isActiveProvider,
        hint: 'Only one plug may own the station’s AC input',
      });
    }
    return list;
  }, [actuators.length, configured, granted, isActiveProvider, plugin.enabled, plugin.kind, plugin.setupActions.length, plugin.status]);

  const current = steps.find((step) => !step.done)?.id ?? null;
  const expanded = openStep ?? current;
  const Panel = panelFor(plugin.id);

  const act = async (work: () => Promise<unknown>, note?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      if (note) setMessage(note);
      await load();
      onChanged();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={plugin.name} subtitle={plugin.description}>
      <XStack>
        <Button size="$2" icon={<Feather name="chevron-left" size={14} />} onPress={onBack}>
          All extensions
        </Button>
      </XStack>

      {message ? (
        <Card borderColor="$borderColor">
          <Text fontSize={13} color="$color" lineHeight={19}>
            {message}
          </Text>
        </Card>
      ) : null}

      {plugin.status === 'failed' || plugin.status === 'degraded' ? (
        <Card borderColor={plugin.status === 'failed' ? '$danger' : '$warning'} gap="$2">
          <Text fontSize={14} fontWeight="700" color={plugin.status === 'failed' ? '$danger' : '$warning'}>
            {STATUS_LABEL[plugin.status]}
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            {plugin.health.detail ?? plugin.error ?? 'No detail available.'}
          </Text>
        </Card>
      ) : null}

      {/* The plugin's own screen, when it ships one and there is something to show. */}
      {Panel && plugin.status === 'healthy' ? (
        <Card gap="$3">
          <Panel
            pluginId={plugin.id}
            health={plugin.health}
            config={config?.values ?? {}}
            capabilities={plugin.capabilities}
            grants={plugin.grants}
            relay={grid?.state ?? null}
            isActiveProvider={isActiveProvider}
            runAction={(actionId, input) => runSetupAction(plugin.id, actionId, input)}
            saveConfig={async (values) => {
              await patchPluginConfig(plugin.id, values);
              await load();
            }}
            switchRelay={async (on, reason) => switchGridRelay(on, reason)}
            refresh={async () => {
              await load();
              onChanged();
            }}
          />
        </Card>
      ) : null}

      {steps.map((step, index) => {
        const open = expanded === step.id;
        return (
          <YStack key={step.id} gap="$2">
            <Card inset>
              <XStack
                alignItems="center"
                gap="$3"
                paddingHorizontal="$4"
                paddingVertical="$3"
                cursor="pointer"
                onPress={() => setOpenStep(open ? '' : step.id)}
              >
                <YStack
                  width={24}
                  height={24}
                  borderRadius={999}
                  alignItems="center"
                  justifyContent="center"
                  backgroundColor={step.done ? '$success' : open ? '$accent' : '$backgroundPress'}
                >
                  {step.done ? (
                    <Feather name="check" size={13} color="#0b0f16" />
                  ) : (
                    <Text fontSize={12} fontWeight="800" color={open ? '$background' : '$muted'}>
                      {index + 1}
                    </Text>
                  )}
                </YStack>
                <YStack flex={1} gap={2}>
                  <Text fontSize={15} fontWeight="600" color="$color">
                    {step.title}
                  </Text>
                  {step.hint && !step.done ? (
                    <Text fontSize={12} color="$muted" lineHeight={17}>
                      {step.hint}
                    </Text>
                  ) : null}
                </YStack>
                <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#64748b" />
              </XStack>

              {open ? (
                <>
                  <RowSeparator />
                  {step.id === 'find' ? (
                    <SetupActions
                      plugin={plugin}
                      busy={busy}
                      inputs={actionInputs}
                      results={actionResults}
                      setInputs={setActionInputs}
                      setResults={setActionResults}
                      onApply={(values) => {
                        setDraft((previous) => ({ ...previous, ...values }));
                        // Send them straight to the settings step, where the
                        // applied values are visible and saveable.
                        setOpenStep('configure');
                      }}
                    />
                  ) : null}

                  {step.id === 'configure' && config ? (
                    <YStack>
                      <SchemaForm
                        schema={config.schema}
                        values={draft}
                        secretsSet={config.secretsSet}
                        disabled={busy}
                        onChange={(name, value) => setDraft((previous) => ({ ...previous, [name]: value }))}
                      />
                      <RowSeparator />
                      <YStack padding="$4">
                        <Button
                          size="$3"
                          backgroundColor="$accent"
                          color="$background"
                          disabled={busy}
                          onPress={() => {
                            haptic();
                            void act(() => patchPluginConfig(plugin.id, draft), 'Settings saved.');
                          }}
                        >
                          {busy ? 'Saving…' : 'Save settings'}
                        </Button>
                      </YStack>
                    </YStack>
                  ) : null}

                  {step.id === 'enable' ? (
                    <ToggleRow
                      title="Enabled"
                      subtitle={
                        plugin.enabled
                          ? 'Running. Turn off to stop it talking to the device.'
                          : 'Off. Nothing is polled and nothing can be switched.'
                      }
                      checked={plugin.enabled}
                      disabled={busy}
                      onCheckedChange={(next) => void act(() => setPluginEnabled(plugin.id, next))}
                    />
                  ) : null}

                  {step.id === 'verify' ? (
                    <YStack padding="$4" gap="$3">
                      <Text fontSize={12} color="$muted" lineHeight={18}>
                        Connects and reads. It never switches anything, so it is safe to press at any
                        time.
                      </Text>
                      <Button
                        size="$3"
                        disabled={busy || !plugin.enabled}
                        opacity={plugin.enabled ? 1 : 0.45}
                        backgroundColor="$backgroundStrong"
                        borderColor="$borderColor"
                        onPress={() => {
                          haptic();
                          void act(async () => {
                            const result = await testPlugin(plugin.id);
                            setMessage(result.detail);
                          });
                        }}
                      >
                        {busy ? 'Testing…' : 'Test connection'}
                      </Button>
                    </YStack>
                  ) : null}

                  {step.id === 'permission' ? (
                    <GrantStep
                      capabilities={actuators}
                      granted={plugin.grants}
                      busy={busy}
                      onGrant={(capability, next) =>
                        void act(() => setPluginGrant(plugin.id, capability, next, ACTUATOR_WORD))
                      }
                    />
                  ) : null}

                  {step.id === 'provider' ? (
                    <YStack padding="$4" gap="$3">
                      <Text fontSize={12} color="$muted" lineHeight={18}>
                        {isActiveProvider
                          ? 'This plug owns the station’s AC input. Automation and manual controls act through it.'
                          : 'Several plugs can be installed, but only one may own the station’s AC input.'}
                      </Text>
                      {!isActiveProvider ? (
                        <Button
                          size="$3"
                          backgroundColor="$accent"
                          color="$background"
                          disabled={busy}
                          onPress={() => {
                            haptic();
                            void act(() => setPluginProvider(plugin.id), 'This plug now owns the grid relay.');
                          }}
                        >
                          Use this plug
                        </Button>
                      ) : null}
                    </YStack>
                  ) : null}
                </>
              ) : null}
            </Card>
          </YStack>
        );
      })}
    </Screen>
  );
}

/** Repeated back to the server to arm a physical action. Shared with the gateway. */
const ACTUATOR_WORD = 'switch-grid-relay';

/** The values a schema says it wants when nothing has been typed. */
function defaultsOf(schema?: ConfigSchema): ConfigValues {
  if (!schema) return {};
  const entries = Object.entries(schema.fields).flatMap(([name, field]) =>
    // Secrets have no default by construction; the rest may.
    'default' in field && field.default !== undefined ? [[name, field.default] as const] : []
  );
  return Object.fromEntries(entries);
}

/** The commissioning helpers a plugin declared, rendered from their schemas. */
function SetupActions({
  plugin,
  busy,
  inputs,
  results,
  setInputs,
  setResults,
  onApply,
}: {
  plugin: PluginSummary;
  busy: boolean;
  inputs: Record<string, ConfigValues>;
  results: Record<string, SetupActionResult>;
  setInputs: React.Dispatch<React.SetStateAction<Record<string, ConfigValues>>>;
  setResults: React.Dispatch<React.SetStateAction<Record<string, SetupActionResult>>>;
  onApply: (values: ConfigValues) => void;
}) {
  const [running, setRunning] = useState<string | null>(null);

  return (
    <YStack>
      {plugin.setupActions.map((action, index) => {
        const result = results[action.id];
        // Start from the schema's defaults rather than blank: an empty "listen
        // for" box invites a wrong answer to a question that already has one.
        const input = inputs[action.id] ?? defaultsOf(action.input);

        return (
          <YStack key={action.id}>
            {index > 0 ? <RowSeparator /> : null}
            <YStack padding="$4" gap="$3">
              <YStack gap={2}>
                <Text fontSize={15} fontWeight="600" color="$color">
                  {action.title}
                </Text>
                {action.description ? (
                  <Text fontSize={12} color="$muted" lineHeight={18}>
                    {action.description}
                  </Text>
                ) : null}
              </YStack>

              {action.input ? (
                <Card inset backgroundColor="$background">
                  <SchemaForm
                    schema={action.input}
                    values={input}
                    disabled={running !== null}
                    onChange={(name, value) =>
                      setInputs((previous) => ({
                        ...previous,
                        [action.id]: { ...(previous[action.id] ?? {}), [name]: value },
                      }))
                    }
                  />
                </Card>
              ) : null}

              <Button
                size="$3"
                backgroundColor="$accent"
                color="$background"
                disabled={busy || running !== null}
                onPress={() => {
                  haptic();
                  setRunning(action.id);
                  void runSetupAction(plugin.id, action.id, input)
                    .then((next) => setResults((previous) => ({ ...previous, [action.id]: next })))
                    .catch((error: unknown) =>
                      setResults((previous) => ({
                        ...previous,
                        [action.id]: { ok: false, detail: describeError(error) },
                      }))
                    )
                    .finally(() => setRunning(null));
                }}
              >
                {running === action.id ? 'Working…' : (action.actionLabel ?? action.title)}
              </Button>

              {result ? (
                <YStack gap="$2">
                  <Text fontSize={12} color={result.ok ? '$muted' : '$danger'} lineHeight={18}>
                    {result.detail}
                  </Text>

                  {/*
                    Choices are the generic ending for a helper: "here are three
                    things, which is yours?". Picking one writes the values the
                    plugin supplied straight into the settings form.
                  */}
                  {result.choices?.map((choice) => (
                    <XStack
                      key={choice.id}
                      alignItems="center"
                      gap="$3"
                      padding="$3"
                      borderRadius="$4"
                      borderWidth={1}
                      borderColor={choice.recommended ? '$accent' : '$borderColor'}
                    >
                      <YStack flex={1} gap={2}>
                        <Text fontSize={14} fontWeight="600" color="$color" numberOfLines={1}>
                          {choice.label}
                        </Text>
                        {choice.detail ? (
                          <Text fontSize={12} color="$muted" numberOfLines={1}>
                            {choice.detail}
                          </Text>
                        ) : null}
                      </YStack>
                      <Button
                        size="$2"
                        backgroundColor="$accent"
                        color="$background"
                        onPress={() => {
                          haptic();
                          onApply(choice.config);
                        }}
                      >
                        Use this
                      </Button>
                    </XStack>
                  ))}
                </YStack>
              ) : null}
            </YStack>
          </YStack>
        );
      })}
    </YStack>
  );
}

/** Consent for anything that moves in the physical world. Two steps, always. */
function GrantStep({
  capabilities,
  granted,
  busy,
  onGrant,
}: {
  capabilities: CapabilityName[];
  granted: CapabilityName[];
  busy: boolean;
  onGrant: (capability: CapabilityName, granted: boolean) => void;
}) {
  const [confirming, setConfirming] = useState<CapabilityName | null>(null);

  return (
    <YStack>
      {capabilities.map((capability, index) => {
        const has = granted.includes(capability);
        return (
          <YStack key={capability}>
            {index > 0 ? <RowSeparator /> : null}
            <YStack padding="$4" gap="$3">
              <Row
                title="Switch the grid relay"
                subtitle={
                  has
                    ? 'Granted. The core may cut and restore mains to the station.'
                    : 'Not granted. Every switch request is refused.'
                }
              />

              {has ? (
                <Button size="$3" disabled={busy} onPress={() => onGrant(capability, false)}>
                  Revoke
                </Button>
              ) : confirming === capability ? (
                <YStack gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$warning">
                  <Text fontSize={13} fontWeight="700" color="$warning">
                    This grants control of mains power
                  </Text>
                  <Text fontSize={12} color="$muted" lineHeight={18}>
                    The relay feeds the station&apos;s AC input. Cutting it makes everything plugged
                    into the station run from battery. Never do this with medical, heating, security
                    or networking equipment connected, and make sure you can reach the plug by hand.
                  </Text>
                  <XStack gap="$2">
                    <Button
                      flex={1}
                      size="$3"
                      backgroundColor="$warning"
                      color="$background"
                      disabled={busy}
                      onPress={() => {
                        setConfirming(null);
                        onGrant(capability, true);
                      }}
                    >
                      I understand — grant
                    </Button>
                    <Button flex={1} size="$3" onPress={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </XStack>
                </YStack>
              ) : (
                <Button
                  size="$3"
                  backgroundColor="$backgroundStrong"
                  borderColor="$borderColor"
                  disabled={busy}
                  onPress={() => {
                    haptic();
                    setConfirming(capability);
                  }}
                >
                  Grant permission
                </Button>
              )}
            </YStack>
          </YStack>
        );
      })}
    </YStack>
  );
}
