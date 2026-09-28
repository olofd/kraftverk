import { useCallback, useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, type CheckOutcome, type ConfigValues, type SetupActionResult, type SetupChoice, type SetupStepView, type SightingView } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SchemaForm, SectionLabel, haptic } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import type { SetupFlow } from './flows';

/**
 * One setup step, drawn from its view (docs/DATA-MODEL.md §1). Nothing here
 * knows a product: a station's "point it at this server", a plug's "fetch the
 * key", the check — all arrive as data from the layers that supply them.
 */

const PRIMARY = { backgroundColor: '$accent', color: '$background' } as const;

export function StepView({
  flow,
  step,
  onNext,
  onChecked,
  presetAddress,
}: {
  flow: SetupFlow;
  step: SetupStepView;
  onNext: () => void;
  onChecked: (outcome: CheckOutcome) => void;
  /** An address chosen before the flow started: "found near you". */
  presetAddress?: string;
}) {
  switch (step.kind) {
    case 'instructions':
      return (
        <Card gap="$3">
          <Text fontSize={15} fontWeight="700" color="$color">
            {step.title}
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={20}>
            {step.body}
          </Text>
          <Button alignSelf="flex-start" size="$3" {...PRIMARY} onPress={onNext}>
            Done — continue
          </Button>
        </Card>
      );
    case 'choose':
      return <ChooseStep flow={flow} step={step} onNext={onNext} presetAddress={presetAddress} />;
    case 'form':
      return <FormStep flow={flow} step={step} onNext={onNext} />;
    case 'discover':
      return <DiscoverStep flow={flow} step={step} onNext={onNext} />;
    case 'check':
      return <CheckStep flow={flow} onChecked={onChecked} />;
  }
}

// --- choose ---------------------------------------------------------------------

function ChooseStep({ flow, step, onNext, presetAddress }: { flow: SetupFlow; step: Extract<SetupStepView, { kind: 'choose' }>; onNext: () => void; presetAddress?: string }) {
  const [sightings, setSightings] = useState<SightingView[]>([]);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  const pick = useCallback(
    async (choice: { address: string } | { manual: string }) => {
      setBusy(true);
      setError(null);
      try {
        await flow.choose(choice);
        onNext();
      } catch (err) {
        setError(describeError(err) || 'That did not work');
      } finally {
        setBusy(false);
      }
    },
    [flow, onNext]
  );

  // A live list: what the transport sees, kept current while this step is open.
  useEffect(() => {
    if (step.discovery !== 'list') return;
    let live = true;
    const load = () =>
      flow
        .sightings()
        .then((next) => live && setSightings(next))
        .catch((err: unknown) => live && setError(describeError(err)));
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [flow, step.discovery]);

  // Found near you: that one, once the list has it.
  useEffect(() => {
    if (!presetAddress || busy) return;
    if (sightings.some((sighting) => sighting.address === presetAddress)) void pick({ address: presetAddress });
  }, [busy, pick, presetAddress, sightings]);

  const openChooser = (showAll: boolean) => {
    haptic();
    setError(null);
    // Straight from the tap: the browser refuses a chooser that was awaited first.
    flow
      .chooser(showAll)
      .then((sighting) => (sighting ? pick({ address: sighting.address }) : undefined))
      .catch((err: unknown) => setError(describeError(err) || 'The chooser could not open'));
  };

  return (
    <YStack gap="$2">
      <SectionLabel>{step.title}</SectionLabel>
      {step.discovery === 'chooser' ? (
        <Card gap="$3">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Your browser shows its own list of nearby devices. Pick yours there.
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            <Button size="$3" {...PRIMARY} disabled={busy} icon={<Feather name="bluetooth" size={14} color={theme.background?.val} />} onPress={() => openChooser(false)}>
              Choose your device
            </Button>
            <Button size="$3" disabled={busy} onPress={() => openChooser(true)}>
              Show every device
            </Button>
          </XStack>
        </Card>
      ) : null}
      {step.discovery === 'list' ? (
        <Card inset>
          {sightings.length === 0 ? (
            <XStack padding="$4" gap="$3" alignItems="center">
              <Spinner color="$accent" />
              <Text flex={1} fontSize={13} color="$muted" lineHeight={19}>
                Looking… It appears here as soon as it can be seen.
              </Text>
            </XStack>
          ) : (
            sightings.map((sighting, index) => (
              <YStack key={sighting.address}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable disabled={busy || sighting.claimedBy !== null} onPress={() => void pick({ address: sighting.address })}>
                  <Row
                    title={sighting.name}
                    subtitle={sighting.claimedBy ? `Already yours: ${sighting.claimedBy.name}` : (sighting.detail ?? sighting.address)}
                    disabled={sighting.claimedBy !== null}
                    accessory={<Feather name={sighting.claimedBy ? 'check' : 'chevron-right'} size={16} color={theme.muted?.val} />}
                  />
                </Pressable>
              </YStack>
            ))
          )}
        </Card>
      ) : null}
      {step.manual ? (
        <Card gap="$2">
          <Text fontSize={13} color="$muted">
            Or type its {step.manual.toLowerCase()}
          </Text>
          <XStack gap="$2">
            <Input flex={1} size="$3" value={manual} onChangeText={setManual} placeholder={step.manual} autoCapitalize="none" backgroundColor="$background" borderColor="$borderColor" />
            <Button size="$3" disabled={busy || !manual.trim()} onPress={() => void pick({ manual })}>
              Use it
            </Button>
          </XStack>
        </Card>
      ) : null}
      {error ? (
        <Text fontSize={12} color="$danger" paddingHorizontal="$1" lineHeight={18}>
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}

// --- forms and helpers --------------------------------------------------------------

function Choices({ result, onPick }: { result: SetupActionResult; onPick: (choice: SetupChoice) => void }) {
  return (
    <YStack gap="$2">
      <Text fontSize={12} color={result.ok ? '$muted' : '$danger'} lineHeight={18} paddingHorizontal="$1">
        {result.detail}
      </Text>
      {result.choices?.length ? (
        <Card inset>
          {result.choices.map((choice, index) => (
            <YStack key={choice.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable onPress={() => onPick(choice)}>
                <Row title={`${choice.label}${choice.recommended ? ' (recommended)' : ''}`} subtitle={choice.detail} />
              </Pressable>
            </YStack>
          ))}
        </Card>
      ) : null}
    </YStack>
  );
}

function FormStep({ flow, step, onNext }: { flow: SetupFlow; step: Extract<SetupStepView, { kind: 'form' }>; onNext: () => void }) {
  const current = () => (step.target === 'device' ? flow.device : flow.connection) as ConfigValues;
  const [values, setValues] = useState<ConfigValues>(current);
  const [result, setResult] = useState<SetupActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (patch: ConfigValues) =>
    flow.update(step.target === 'device' ? { device: patch } : { connection: patch });

  const run = async (work: () => Promise<void>) => {
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

  return (
    <YStack gap="$2">
      <SectionLabel>{step.title}</SectionLabel>
      {step.description ? (
        <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
          {step.description}
        </Text>
      ) : null}
      <Card inset>
        <SchemaForm schema={step.schema} values={values} secretsSet={flow.secrets} disabled={busy} onChange={(name, value) => setValues((before) => ({ ...before, [name]: value }))} />
      </Card>
      {step.actions.length ? (
        <XStack gap="$2" flexWrap="wrap">
          {step.actions.map((action) => (
            <Button
              key={action.id}
              size="$3"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  const next = await flow.action(step.id, action.id, {});
                  setResult(next);
                  setValues(current());
                })
              }
            >
              {action.label}
            </Button>
          ))}
        </XStack>
      ) : null}
      {busy ? <Spinner color="$accent" /> : null}
      {result ? (
        <Choices
          result={result}
          onPick={(choice) =>
            void run(async () => {
              await apply(choice.config);
              setValues(current());
              setResult(null);
            })
          }
        />
      ) : null}
      {error ? (
        <Text fontSize={12} color="$danger" paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
      <Button alignSelf="flex-start" size="$3" {...PRIMARY} disabled={busy} onPress={() => void run(async () => {
        await apply(values);
        onNext();
      })}>
        Continue
      </Button>
    </YStack>
  );
}

function DiscoverStep({ flow, step, onNext }: { flow: SetupFlow; step: Extract<SetupStepView, { kind: 'discover' }>; onNext: () => void }) {
  const [result, setResult] = useState<SetupActionResult | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    try {
      setResult(await flow.discover(step.id));
    } catch (err) {
      setResult({ ok: false, detail: describeError(err) || 'The search failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>{step.title}</SectionLabel>
      {step.description ? (
        <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
          {step.description}
        </Text>
      ) : null}
      <XStack gap="$2">
        <Button size="$3" disabled={busy} onPress={() => void search()}>
          Search
        </Button>
        <Button size="$3" disabled={busy} onPress={onNext}>
          Skip
        </Button>
      </XStack>
      {busy ? <Spinner color="$accent" /> : null}
      {result ? (
        <Choices
          result={result}
          onPick={(choice) => {
            void flow.update(step.target === 'device' ? { device: choice.config } : { connection: choice.config }).then(onNext);
          }}
        />
      ) : null}
    </YStack>
  );
}

// --- check ----------------------------------------------------------------------

function CheckStep({ flow, onChecked }: { flow: SetupFlow; onChecked: (outcome: CheckOutcome) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onChecked(await flow.check());
    } catch (err) {
      setError(describeError(err) || 'The check did not run');
    } finally {
      setBusy(false);
    }
  }, [flow, onChecked]);

  useEffect(() => {
    void check();
    // Once, when the step opens; "Try again" runs it after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card gap="$3" alignItems="flex-start">
      <XStack gap="$3" alignItems="center">
        {busy ? <Spinner color="$accent" /> : null}
        <Text fontSize={14} color="$color">
          {busy ? 'Reading it once to check it answers…' : (error ?? 'Checked.')}
        </Text>
      </XStack>
      {!busy && error ? (
        <Button size="$3" onPress={() => void check()}>
          Try again
        </Button>
      ) : null}
    </Card>
  );
}
