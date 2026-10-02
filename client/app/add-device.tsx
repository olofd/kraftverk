import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import {
  CATEGORIES,
  describeError,
  SetupFlow,
  type CheckOutcome,
  type DeviceTypeListing,
  type DeviceView,
  type Holder,
  type SaveInput,
} from '@kraftverk/api-client';
import { LINK_KIND_IDS, linkableParts, linkKindSpec, MAIN_PART, partName, SIMULATED_METHOD_ID, type DeviceDescription } from '@kraftverk/device-sdk';
import { Card, Row, RowSeparator, SectionLabel, ToggleRow, haptic, Icon } from '@kraftverk/ui';

import { DeviceImage } from '../src/components/DeviceImage';
import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';

import { StepView } from '../src/features/add/steps';
import { secretWords } from '../src/features/config/shared';
import { confirmAction } from '../src/platform/confirm';
import { featherName } from '../src/lib/icons';
import { HERE, HERE_PLATFORM } from '../src/platform/here';
import { useDevices } from '../src/state/DevicesProvider';
import { useHome } from '../src/state/HomeProvider';

/**
 * Adding a device (docs/DATA-MODEL.md §1).
 *
 * What are you adding → which one → how do you want to connect → the steps
 * that connection's layers supply → the check → a name and how it fits the
 * house → saved. Every step that touches the device runs where the connection
 * will be held: the home — a server, or the app's own — or this app, for a
 * server. `?attach=<id>` adds another way to
 * reach a device you have; `?type=&method=&address=` comes from "Found near you".
 */

type Stage = 'category' | 'type' | 'method' | 'steps' | 'finish';

/** One way to connect, and who would hold it. */
type Way = { methodId: string; label: string; description?: string; holder: Holder; available: boolean; reason: string | null; recommended: boolean };

export default function AddDeviceScreen() {
  const params = useLocalSearchParams<{ type?: string; method?: string; address?: string; attach?: string }>();
  const { devices, refresh } = useDevices();
  const { api, role } = useHome();
  const attachTo = params.attach ? (devices.find((device) => device.id === params.attach) ?? null) : null;

  const [types, setTypes] = useState<DeviceTypeListing[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>(params.type ? 'method' : 'category');
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeId, setTypeId] = useState<string | null>(params.type ?? null);
  const [flow, setFlow] = useState<SetupFlow | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  /** What a helper learnt the device is called — its name in its maker's app — offered when it is named. */
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowRef = useRef<SetupFlow | null>(null);

  // What can be added: the home's installed types, and whether it can hold each way.
  useEffect(() => {
    let live = true;
    api
      .deviceTypes()
      .then((list) => live && setTypes(list.types))
      .catch((err: unknown) => live && setLoadError(describeError(err) || 'What can be added could not be read'));
    return () => {
      live = false;
    };
  }, [api]);

  // A draft left behind is discarded, so a secret it holds does not outlive the screen.
  useEffect(() => () => flowRef.current?.discard(), []);

  const type = types?.find((candidate) => candidate.id === typeId) ?? null;

  const ways = useMemo((): Way[] => {
    if (!type) return [];
    /*
      Every way the home offers, in its type's order: the home's own —
      through your server, or from where the app keeps its own — and, with a
      server, this app's own radio for it. Each says whether it can be used
      now, and why not.
    */
    return type.connections.flatMap((method): Way[] =>
      type.ways
        .filter((way) => way.method === method.id)
        .map((way) => ({
          methodId: method.id,
          label: `${method.label}, ${way.holder === 'master' && role === 'follower' ? 'through your server' : `from ${HERE}`}`,
          description: way.holder === 'this-node' ? `While ${HERE} has it: kept by your server, which hears what it says when it can.` : method.description,
          holder: way.holder,
          available: way.availability.ok,
          reason: way.availability.ok ? null : way.availability.reason,
          recommended: way.holder === 'master' && Boolean(method.recommended),
        }))
    );
  }, [role, type]);

  const begin = useCallback(
    async (way: Way) => {
      if (!type) return;
      haptic();
      setBusy(true);
      setError(null);
      try {
        flowRef.current?.discard();
        const next: SetupFlow = await SetupFlow.start(api, type.id, way.methodId, way.holder);
        flowRef.current = next;
        setFlow(next);
        setStepIndex(0);
        setOutcome(null);
        setSuggestedName(null);
        setStage('steps');
      } catch (err) {
        setError(describeError(err) || 'That way cannot be used right now');
      } finally {
        setBusy(false);
      }
    },
    [api, type]
  );

  // "Found near you" names the method too: start it straight away.
  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || !params.method || !type) return;
    const way = ways.find((candidate) => candidate.methodId === params.method && candidate.holder === 'master' && candidate.available);
    if (!way) return;
    autostarted.current = true;
    void begin(way);
  }, [begin, params.method, type, ways]);

  const title = attachTo ? `Another way to reach ${attachTo.name}` : 'Add a device';

  // --- moving through the steps ---------------------------------------------------------

  /** Forward. Finding the device on the network is skipped when an earlier step already found it. */
  const next = useCallback(() => {
    if (!flow) return;
    setStepIndex((index) => {
      const to = Math.min(index + 1, flow.plan.length - 1);
      return skipsChoose(flow, to) ? to + 1 : to;
    });
  }, [flow]);

  /** Back one step, keeping everything entered; from the first, back to choosing how to connect. */
  const back = useCallback(() => {
    if (!flow) return;
    haptic();
    if (stepIndex === 0) {
      flowRef.current?.discard();
      flowRef.current = null;
      setFlow(null);
      setStage('method');
      return;
    }
    setOutcome(null);
    // Past a step it passed over going forward, as the progress bar does.
    const to = stepIndex - 1;
    setStepIndex(skipsChoose(flow, to) && to > 0 ? to - 1 : to);
  }, [flow, stepIndex]);

  /** Straight to an earlier step, from the progress bar. */
  const goTo = useCallback((index: number) => {
    haptic();
    setOutcome(null);
    setStage('steps');
    setStepIndex(index);
  }, []);

  return (
    <Screen back={attachTo ? attachTo.name : 'Your devices'} backTo={attachTo ? `/device/${encodeURIComponent(attachTo.id)}/settings` : '/'} title={title} subtitle={type?.meta.name}>
      {loadError ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {loadError}
          </Text>
        </Card>
      ) : null}
      {!types && !loadError ? <Spinner color="$accent" /> : null}

      {types && stage === 'category' ? (
        <>
          <Input
            size="$3"
            value={query}
            placeholder="Search by brand or model"
            autoCapitalize="none"
            onChangeText={setQuery}
            backgroundColor="$background"
            borderColor="$borderColor"
            aria-label="Search by brand or model"
          />
          {query.trim() ? (
            <Types
              types={types.filter((candidate) => matches(candidate, query))}
              onPick={(id) => {
                setTypeId(id);
                setStage('method');
              }}
              onBack={() => setQuery('')}
            />
          ) : (
            <Categories types={types} onPick={(id) => (setCategory(id), setStage('type'))} />
          )}
        </>
      ) : null}

      {types && stage === 'type' ? (
        <Types
          types={types.filter((candidate) => candidate.meta.category === category)}
          onPick={(id) => {
            setTypeId(id);
            setStage('method');
          }}
          onBack={() => setStage('category')}
        />
      ) : null}

      {stage === 'method' && type ? (
        <Ways ways={ways} busy={busy} onPick={(way) => void begin(way)} onBack={params.type ? undefined : () => setStage('type')} />
      ) : null}

      {(stage === 'steps' || stage === 'finish') && flow ? (
        <Progress
          steps={[
            ...flow.plan
              .map((step, index) => ({ title: step.title, index, skipped: skipsChoose(flow, index) && index !== stepIndex }))
              .filter((step) => !step.skipped),
            { title: attachTo ? 'Add it' : 'Name it', index: flow.plan.length },
          ]}
          at={stage === 'finish' ? flow.plan.length : stepIndex}
          onGoTo={goTo}
        />
      ) : null}

      {stage === 'steps' && flow ? (
        outcome ? (
          <Outcome
            outcome={outcome}
            attachTo={attachTo}
            earlier={flow.plan.length > 1}
            onBack={() => {
              // To the step before the check; with none, to choosing how to reach it.
              if (flow.plan.length > 1) {
                setOutcome(null);
                setStepIndex(flow.plan.length - 2);
              } else {
                setStepIndex(0);
                back();
              }
            }}
            onRetry={() => setOutcome(null)}
            onContinue={() => setStage('finish')}
            onOtherType={(id) => {
              setTypeId(id);
              setStage('method');
            }}
          />
        ) : (
          <StepView
            key={flow.plan[stepIndex]?.id}
            flow={flow}
            step={flow.plan[stepIndex]!}
            presetAddress={params.address}
            onNext={next}
            onBack={back}
            onChecked={setOutcome}
            onNamed={setSuggestedName}
          />
        )
      ) : null}

      {stage === 'finish' && flow && outcome && type ? (
        <Finish
          flow={flow}
          outcome={outcome}
          onBack={() => setStage('steps')}
          typeName={suggestedName ?? type.meta.name}
          description={type.description}
          attachTo={attachTo}
          devices={devices}
          onSaved={async (id) => {
            flowRef.current = null;
            await refresh();
            router.replace(`/device/${encodeURIComponent(id)}`);
          }}
        />
      ) : null}

      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}

// --- 1 · what are you adding ------------------------------------------------------

/** Finding the device on the network, when an earlier step already found it: passed over both ways. The last step is never passed over. */
function skipsChoose(flow: SetupFlow, index: number): boolean {
  return flow.plan[index]?.kind === 'choose' && flow.address !== null && index < flow.plan.length - 1;
}

/** Whether a type answers to what was typed: every word somewhere in its name, brand, models or description. */
function matches(type: DeviceTypeListing, query: string): boolean {
  const text = [type.meta.name, type.meta.brand, ...(type.meta.models ?? []), type.meta.description, (CATEGORIES as Record<string, { label: string }>)[type.meta.category]?.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

type Section = 'devices' | 'services' | 'empty';

const SECTION_LABELS: Record<Section, string> = { devices: 'Devices', services: 'Services', empty: 'Nothing installed yet' };

function Categories({ types, onPick }: { types: DeviceTypeListing[]; onPick: (id: string) => void }) {
  const theme = useTheme();
  /*
    Where a shelf goes is what is installed on it says: services when all of
    it is, devices otherwise. A shelf with nothing on it has nothing to say
    which it is, so it is listed apart rather than guessed into one.
  */
  const sectionOf = (id: string): Section => {
    const installed = types.filter((type) => type.meta.category === id);
    if (!installed.length) return 'empty';
    return installed.every((type) => type.kind === 'service') ? 'services' : 'devices';
  };
  const sections = (['devices', 'services', 'empty'] as const)
    .map((section) => ({ section, categories: Object.entries(CATEGORIES).filter(([id]) => sectionOf(id) === section) }))
    .filter(({ categories }) => categories.length > 0);
  return (
    <>
      {sections.map(({ section, categories }) => (
        <YStack key={section} gap="$2">
          <SectionLabel>{SECTION_LABELS[section]}</SectionLabel>
          <Card inset>
            {categories.map(([id, spec], index) => {
              const installed = types.filter((type) => type.meta.category === id);
              const count = installed.length;
              return (
                <YStack key={id}>
                  {index > 0 ? <RowSeparator /> : null}
                  <Pressable disabled={count === 0} onPress={() => onPick(id)}>
                    <XStack alignItems="center" gap="$3" paddingLeft="$4">
                      <Icon name={featherName(spec.icon)} size={18} color={count ? theme.accent?.val : theme.muted?.val} />
                      <YStack flex={1}>
                        <Row title={spec.label} subtitle={count ? installed.map((type) => type.meta.name).join(', ') : 'No package for these is installed'} disabled={count === 0} />
                      </YStack>
                    </XStack>
                  </Pressable>
                </YStack>
              );
            })}
          </Card>
        </YStack>
      ))}
      <YStack gap="$2">
        <SectionLabel>Already described</SectionLabel>
        <Card inset>
          <Pressable onPress={() => router.push('/configuration?import=1')}>
            <XStack alignItems="center" gap="$3" paddingLeft="$4">
              <Icon name="file-text" size={18} color={theme.accent?.val} />
              <YStack flex={1}>
                <Row title="From a configuration" subtitle="A device exported from here or another kraftverk, or written by hand: pasted, or opened as a file" />
              </YStack>
            </XStack>
          </Pressable>
        </Card>
      </YStack>
    </>
  );
}

// --- 2 · which one ------------------------------------------------------------------

const SUPPORT: Record<string, string> = {
  verified: 'Verified on real hardware',
  community: 'Reported working by others',
  experimental: 'Experimental',
};

/**
 * Where a type can run, in words, against where this home is: through your
 * server, from this phone, or both — and, with no server, that a real one
 * needs a server and only its simulator runs here. From its ways: each a
 * node can hold at all, simulated apart.
 */
function whereItRuns(type: Pick<DeviceTypeListing, 'ways'>, role: 'follower' | 'master'): string {
  const real = type.ways.filter((way) => way.fits && way.method !== SIMULATED_METHOD_ID);
  // Without a server, the master is this app's own node.
  const here = real.some((way) => way.holder === (role === 'master' ? 'master' : 'this-node'));
  const server = role === 'follower' && real.some((way) => way.holder === 'master');
  if (role === 'master') return here ? `Works from ${HERE}` : 'Needs a server: here, only its simulator';
  if (here && server) return `Through your server, or from ${HERE}`;
  return server ? 'Through your server' : `From ${HERE} only`;
}

function Types({ types, onPick, onBack }: { types: DeviceTypeListing[]; onPick: (id: string) => void; onBack: () => void }) {
  const theme = useTheme();
  const { role } = useHome();
  return (
    <YStack gap="$2">
      <SectionLabel>Which one?</SectionLabel>
      <Card inset>
        {types.length === 0 ? <Row title="Nothing installed matches that" subtitle="Try the brand, or the model printed on it" /> : null}
        {types.map((type, index) => (
          <YStack key={type.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable onPress={() => onPick(type.id)}>
              <Row
                leading={<DeviceImage typeId={type.id} size={40} />}
                title={type.meta.name}
                subtitle={[whereItRuns(type, role), type.meta.description, SUPPORT[type.meta.support], type.meta.models?.length ? `Models: ${type.meta.models.join(', ')}` : null].filter(Boolean).join(' · ')}
                accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </YStack>
        ))}
      </Card>
      <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
        Don’t see yours? Each model is supported by a package of its own, and one can be written for it.
      </Text>
      <Button alignSelf="flex-start" size="$2" onPress={onBack}>
        Back
      </Button>
    </YStack>
  );
}

// --- 3 · how do you want to connect -------------------------------------------------

function Ways({ ways, busy, onPick, onBack }: { ways: Way[]; busy: boolean; onPick: (way: Way) => void; onBack?: () => void }) {
  const theme = useTheme();
  const { role } = useHome();
  return (
    <YStack gap="$2">
      <SectionLabel>How do you want to connect?</SectionLabel>
      <Card inset>
        {ways.length === 0 ? (
          <Row title="No way to reach it from here" subtitle={role === 'follower' ? 'Neither your server nor this app has what it needs' : 'This app has nothing that reaches it'} />
        ) : null}
        {ways.map((way, index) => (
          <YStack key={`${way.methodId}-${way.holder}`}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable disabled={busy || !way.available} onPress={() => onPick(way)}>
              <Row
                title={`${way.label}${way.recommended ? ' · recommended' : ''}`}
                subtitle={way.available ? way.description : (way.reason ?? 'Not available here')}
                disabled={!way.available}
                accessory={<Icon name={way.holder === 'master' && role === 'follower' ? 'server' : HERE_PLATFORM === 'web' ? 'monitor' : 'smartphone'} size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </YStack>
        ))}
      </Card>
      {busy ? <Spinner color="$accent" /> : null}
      {onBack ? (
        <Button alignSelf="flex-start" size="$2" onPress={onBack}>
          Back
        </Button>
      ) : null}
    </YStack>
  );
}

/**
 * Where you are in setting it up: "Step 2 of 5", and a bar of as many segments.
 * Done ones are filled, and a tap on one goes back to it with everything kept;
 * the step's own title is the heading below, so it is not said twice.
 *
 * `steps` are the ones the person goes through, each with its place in the
 * plan: a step the flow passed over (finding a device an earlier step already
 * found) is not counted, nor drawn as done.
 */
function Progress({ steps, at, onGoTo }: { steps: { title: string; index: number }[]; at: number; onGoTo: (index: number) => void }) {
  const now = Math.max(0, steps.findIndex((step) => step.index === at));
  return (
    <YStack gap="$2">
      <Text fontSize={12} fontWeight="700" color="$muted" letterSpacing={0.6} textTransform="uppercase">
        Step {now + 1} of {steps.length}
      </Text>
      <XStack gap={4} aria-label="Setup steps">
        {steps.map((step, position) => {
          const done = position < now;
          return (
            <YStack
              key={`${step.title}-${step.index}`}
              flex={1}
              // A done step is a button: Tab reaches it, Enter or Space goes back to it.
              role={done ? 'button' : undefined}
              tabIndex={done ? 0 : undefined}
              aria-label={`${step.title}${done ? ', done: go back to it' : position === now ? ', now' : ''}`}
              aria-current={position === now ? 'step' : undefined}
              paddingVertical={6}
              cursor={done ? 'pointer' : 'default'}
              onPress={done ? () => onGoTo(step.index) : undefined}
              hoverStyle={done ? { opacity: 0.7 } : undefined}
              focusVisibleStyle={done ? { outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid', borderRadius: 4 } : undefined}
            >
              <YStack height={6} borderRadius={3} backgroundColor={position <= now ? '$accent' : '$backgroundPress'} opacity={done ? 0.55 : 1} />
            </YStack>
          );
        })}
      </XStack>
    </YStack>
  );
}

// --- 7 · what the check found -------------------------------------------------------

function Outcome({
  outcome,
  attachTo,
  earlier,
  onBack,
  onRetry,
  onContinue,
  onOtherType,
}: {
  outcome: CheckOutcome;
  attachTo: DeviceView | null;
  /** There are steps before the check to go back to. */
  earlier: boolean;
  /** To the step before the check, to change what was entered — or, with none, to how it is reached. */
  onBack: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onOtherType: (typeId: string) => void;
}) {
  const [tone, heading] =
    outcome.outcome === 'new'
      ? (['$success', attachTo ? `It answered. Is it ${attachTo.name}?` : 'It answered'] as const)
      : outcome.outcome === 'yours'
        ? (['$accent', attachTo && outcome.device.id === attachTo.id ? `This is ${attachTo.name}` : `You already have this: ${outcome.device.name}`] as const)
        : outcome.outcome === 'removed'
          ? (['$accent', 'You had this before'] as const)
          : outcome.outcome === 'other-model'
            ? (['$warning', 'That is a different product'] as const)
            : (['$warning', 'It did not answer'] as const);

  const canContinue =
    outcome.outcome === 'new' ||
    outcome.outcome === 'removed' ||
    (outcome.outcome === 'yours' && attachTo !== null && outcome.device.id === attachTo.id) ||
    (outcome.outcome === 'no-answer' && Boolean(outcome.saveAnyway));

  return (
    <Card gap="$3" borderColor={tone}>
      <Text fontSize={15} fontWeight="700" color={tone}>
        {heading}
      </Text>
      <Text fontSize={13} color="$muted" lineHeight={19}>
        {outcome.summary}
        {outcome.outcome === 'no-answer' && outcome.saveAnyway ? ` ${outcome.saveAnyway}` : ''}
        {outcome.outcome === 'new' && attachTo && outcome.identity === null
          ? ` It cannot say which device it is from here, so it is taken on your word that it is ${attachTo.name}.`
          : ''}
      </Text>
      <XStack gap="$2" flexWrap="wrap">
        {canContinue ? (
          <Button size="$3" backgroundColor="$accent" color="$background" onPress={onContinue}>
            {outcome.outcome === 'no-answer' ? 'Save it anyway' : 'Continue'}
          </Button>
        ) : null}
        {outcome.outcome === 'yours' && (!attachTo || outcome.device.id !== attachTo.id) ? (
          <Button size="$3" onPress={() => router.replace(`/device/${encodeURIComponent(outcome.device.id)}`)}>
            Open {outcome.device.name}
          </Button>
        ) : null}
        {outcome.outcome === 'other-model' && outcome.type ? (
          <Button size="$3" onPress={() => onOtherType(outcome.type!.id)}>
            Set it up as {outcome.type.name}
          </Button>
        ) : null}
        <Button size="$3" onPress={onRetry}>
          Try again
        </Button>
        <Button size="$3" chromeless color="$muted" onPress={onBack}>
          {earlier ? 'Change what I entered' : 'Reach it another way'}
        </Button>
      </XStack>
    </Card>
  );
}

// --- 8 · name it, and how it fits the house ------------------------------------------

function Finish({
  flow,
  outcome,
  onBack,
  typeName,
  description,
  attachTo,
  devices,
  onSaved,
}: {
  flow: SetupFlow;
  outcome: CheckOutcome;
  onBack: () => void;
  /** The name offered: what its maker's app calls it, when a helper learnt that, else its model. */
  typeName: string;
  /** What it is, as its type describes it: which links fit is decided the way the server decides it. */
  description: DeviceDescription;
  attachTo: DeviceView | null;
  devices: DeviceView[];
  onSaved: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(typeName);
  const [restore, setRestore] = useState<string | null>(outcome.outcome === 'removed' ? (outcome.devices[0]?.id ?? null) : null);
  /** By question, the other end chosen: "device|part", or empty for none. */
  const [links, setLinks] = useState<Record<string, string>>({});
  /** Whether the secrets just given may leave in an export as plain text: off unless chosen, and warned against (docs/CONFIG.md). */
  const [exportable, setExportable] = useState(false);
  const keepsSecrets = flow.holder === 'master' && flow.secrets.length > 0;
  const { role: nodeRole } = useHome();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Questions a link kind asks, one per part of this device that fits one end, with the parts of devices you have that fit the other.
  const questions = LINK_KIND_IDS.flatMap((kind) => {
    const spec = linkKindSpec(kind);
    const ask = (role: 'source' | 'target') =>
      linkableParts(kind, description, role).flatMap((part) => {
        const options = devices.flatMap((other) =>
          linkableParts(kind, other.description, role === 'source' ? 'target' : 'source').map((otherPart) => ({
            value: `${other.id}|${otherPart.id}`,
            title: partName(other.name, otherPart.id, otherPart.label),
            subtitle: other.meta.name,
          }))
        );
        const question = role === 'source' ? spec.question.fromSide : spec.question.toSide;
        return options.length
          ? [{ key: `${kind}:${role}:${part.id}`, kind, role, part: part.id, question: part.id === MAIN_PART ? question : `${part.label}: ${question}`, options }]
          : [];
      });
    return [...ask('source'), ...ask('target')];
  });

  const save = async () => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const input: SaveInput = attachTo
        ? { name: '', mode: 'attach', deviceId: attachTo.id }
        : restore
          ? { name, mode: 'restore', deviceId: restore }
          : {
              name,
              mode: 'new',
              anyway: outcome.outcome === 'no-answer' ? true : undefined,
              links: questions.flatMap((question) => {
                const chosen = links[question.key];
                if (!chosen) return [];
                const [device, part] = chosen.split('|') as [string, string];
                return [{ kind: question.kind, part: question.part, other: { device, part }, role: question.role }];
              }),
            };
      if (attachTo && outcome.outcome === 'no-answer') input.anyway = true;
      if (keepsSecrets && exportable) input.secretsExportable = true;
      await onSaved(await flow.save(input));
    } catch (err) {
      setError(describeError(err) || 'It could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3">
      {outcome.outcome === 'removed' && !attachTo ? (
        <YStack gap="$2">
          <SectionLabel>Bring it back?</SectionLabel>
          <Card inset>
            {outcome.devices.map((device, index) => (
              <YStack key={device.id}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable selected={restore === device.id} onPress={() => setRestore(device.id)}>
                  <Row title={`Bring back ${device.name}, with its history`} subtitle={`Removed ${new Date(device.removedAt).toLocaleDateString()}`} />
                </Pressable>
              </YStack>
            ))}
            <RowSeparator />
            <Pressable selected={restore === null} onPress={() => setRestore(null)}>
              <Row title="Start fresh" subtitle="A new device; the old one stays removed, with its history" />
            </Pressable>
          </Card>
        </YStack>
      ) : null}

      {attachTo ? null : (
        <YStack gap="$2">
          <SectionLabel>Name it</SectionLabel>
          <Card gap="$2">
            <Input size="$3" value={name} maxLength={60} onChangeText={setName} onSubmitEditing={() => (!busy && (attachTo || name.trim()) ? void save() : undefined)} backgroundColor="$background" borderColor="$borderColor" aria-label="Its name" />
            <Text fontSize={12} color="$muted">
              {flow.holder === 'master' && nodeRole === 'follower' ? 'Held by your server.' : `Held by ${HERE}.`}
            </Text>
          </Card>
        </YStack>
      )}

      {!attachTo && !restore
        ? questions.map((question) => (
            <YStack key={question.key} gap="$2">
              <SectionLabel>{question.question}</SectionLabel>
              <Card inset>
                <Pressable selected={!links[question.key]} onPress={() => setLinks((before) => ({ ...before, [question.key]: '' }))}>
                  <Row title="None of these" />
                </Pressable>
                {question.options.map((option) => (
                  <YStack key={option.value}>
                    <RowSeparator />
                    <Pressable selected={links[question.key] === option.value} onPress={() => setLinks((before) => ({ ...before, [question.key]: option.value }))}>
                      <Row title={option.title} subtitle={option.subtitle} />
                    </Pressable>
                  </YStack>
                ))}
              </Card>
            </YStack>
          ))
        : null}

      {keepsSecrets ? (
        <YStack gap="$2">
          <SectionLabel>Its {secretWords(flow.secrets)}</SectionLabel>
          <Card inset>
            <ToggleRow
              title="May leave in plain text"
              subtitle={
                exportable
                  ? 'An export that asks for plain text carries it as it is: anyone with the file can reach the device as you do.'
                  : 'Off: an export leaves it out, or seals it with a passphrase you choose. Kept safely on your server either way.'
              }
              checked={exportable}
              onCheckedChange={(on) =>
                void (async () => {
                  if (
                    on &&
                    !(await confirmAction(
                      'Let it leave in plain text?',
                      `An export that asks for plain text will carry its ${secretWords(flow.secrets)} as it is. Anyone who has the file — a backup, a mail, a shared folder — can then reach the device as you do.\n\nAn export sealed with a passphrase carries it safely without this. You can change this later, under its settings.`,
                      'Let it leave',
                      'dangerous'
                    ))
                  )
                    return;
                  setExportable(on);
                })()
              }
            />
          </Card>
        </YStack>
      ) : null}

      <XStack justifyContent="space-between" alignItems="center">
        <Button size="$3" chromeless color="$muted" onPress={onBack}>
          Back
        </Button>
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || (!attachTo && !name.trim())} onPress={() => void save()}>
          {busy ? 'Saving…' : attachTo ? `Add it to ${attachTo.name}` : restore ? 'Bring it back' : 'Save'}
        </Button>
      </XStack>
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18}>
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}
