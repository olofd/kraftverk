import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, type CheckOutcome, type ConfigValues, type SetupActionResult, type SetupActionView, type SetupChoice, type SetupStepView, type SightingView } from '@kraftverk/api-client';
import { Card, isComplete, Row, RowSeparator, SchemaForm, haptic, Icon } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { QrCode } from '../../components/QrCode';
import type { SetupFlow } from './flows';

/**
 * One setup step, drawn from its view (docs/DATA-MODEL.md §1). Nothing here
 * knows a product: a station's "point it at this server", a plug's "sign in
 * with the maker's app", the check — all arrive as data from the layers that
 * supply them.
 *
 * Every step can go back. What was entered stays in the draft, so going back
 * and forward again changes only what is changed.
 */

const PRIMARY = { backgroundColor: '$accent', color: '$background' } as const;

type StepProps = {
  flow: SetupFlow;
  onNext: () => void;
  /** Back to the step before, or to choosing how to connect from the first. */
  onBack: () => void;
};

export function StepView({
  flow,
  step,
  onNext,
  onBack,
  onChecked,
  onNamed,
  presetAddress,
}: StepProps & {
  step: SetupStepView;
  onChecked: (outcome: CheckOutcome) => void;
  /** A helper learnt what the device is called: offered as its name when it is saved. */
  onNamed: (name: string) => void;
  /** An address chosen before the flow started: "found near you". */
  presetAddress?: string;
}) {
  switch (step.kind) {
    case 'instructions':
      return (
        <StepFrame title={step.title} onBack={onBack} next={{ label: 'It is ready', onPress: onNext }}>
          <Card gap="$3">
            <Text fontSize={14} color="$color" lineHeight={21}>
              {step.body}
            </Text>
          </Card>
        </StepFrame>
      );
    case 'choose':
      return <ChooseStep flow={flow} step={step} onNext={onNext} onBack={onBack} presetAddress={presetAddress} />;
    case 'form':
      return <FormStep flow={flow} step={step} onNext={onNext} onBack={onBack} onNamed={onNamed} />;
    case 'discover':
      return <DiscoverStep flow={flow} step={step} onNext={onNext} onBack={onBack} />;
    case 'check':
      return <CheckStep flow={flow} onChecked={onChecked} onBack={onBack} />;
  }
}

/**
 * What every step looks like: its title, what it is for, what it asks, and a
 * footer — Back always on the left, the way forward on the right.
 */
function StepFrame({
  title,
  description,
  children,
  onBack,
  next,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onBack: () => void;
  next?: { label: string; onPress: () => void; disabled?: boolean };
}) {
  const theme = useTheme();
  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <Text fontSize={20} fontWeight="800" color="$color" letterSpacing={-0.3}>
          {title}
        </Text>
        {description ? (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {description}
          </Text>
        ) : null}
      </YStack>
      {children}
      <XStack justifyContent="space-between" alignItems="center" paddingTop="$1">
        <Button size="$3" chromeless icon={<Icon name="chevron-left" size={16} color={theme.muted?.val} />} onPress={onBack} color="$muted">
          Back
        </Button>
        {next ? (
          <Button size="$3" {...PRIMARY} disabled={next.disabled} opacity={next.disabled ? 0.5 : 1} onPress={next.onPress}>
            {next.label}
          </Button>
        ) : null}
      </XStack>
    </YStack>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <Text fontSize={13} color="$danger" lineHeight={19} paddingHorizontal="$1">
      {message}
    </Text>
  ) : null;
}

// --- choose ---------------------------------------------------------------------

function ChooseStep({ flow, step, onNext, onBack, presetAddress }: StepProps & { step: Extract<SetupStepView, { kind: 'choose' }>; presetAddress?: string }) {
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
    if (!presetAddress || busy || flow.address) return;
    if (sightings.some((sighting) => sighting.address === presetAddress)) void pick({ address: presetAddress });
  }, [busy, flow.address, pick, presetAddress, sightings]);

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
    <StepFrame
      title={step.title}
      description={flow.address ? undefined : step.discovery === 'list' ? 'Devices on your network that could be it. Choose yours.' : undefined}
      onBack={onBack}
      next={flow.address ? { label: `Use ${flow.address}`, onPress: onNext } : undefined}
    >
      {flow.address ? (
        <Card gap="$2">
          <Text fontSize={14} color="$color" lineHeight={20}>
            It is at {flow.address}. Choose another below if that is not the one.
          </Text>
        </Card>
      ) : null}
      {step.discovery === 'chooser' ? (
        <Card gap="$3">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Your browser shows its own list of nearby devices. Pick yours there.
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            <Button size="$3" {...PRIMARY} disabled={busy} icon={<Icon name="bluetooth" size={14} color={theme.background?.val} />} onPress={() => openChooser(false)}>
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
                Looking… It appears here as soon as it can be seen. A device already connected to something else may stay quiet: type its address below.
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
                    accessory={<Icon name={sighting.claimedBy ? 'check' : 'chevron-right'} size={16} color={theme.muted?.val} />}
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
            <Input
              flex={1}
              size="$3"
              value={manual}
              onChangeText={setManual}
              placeholder={step.manual}
              aria-label={step.manual}
              autoCapitalize="none"
              backgroundColor="$background"
              borderColor="$borderColor"
              onSubmitEditing={() => (manual.trim() ? void pick({ manual }) : undefined)}
            />
            <Button size="$3" disabled={busy || !manual.trim()} onPress={() => void pick({ manual })}>
              Use it
            </Button>
          </XStack>
        </Card>
      ) : null}
      <ErrorLine message={error} />
    </StepFrame>
  );
}

// --- forms, and the helpers beside them ------------------------------------------------

/** A helper's candidates: which one is it? */
function Choices({ result, picking, onPick }: { result: SetupActionResult; picking: string | null; onPick: (choice: SetupChoice) => void }) {
  return (
    <YStack gap="$2">
      <Text fontSize={13} color={result.ok ? '$color' : '$danger'} lineHeight={19} paddingHorizontal="$1">
        {result.detail}
      </Text>
      {result.choices?.length ? (
        <Card inset>
          {result.choices.map((choice, index) => (
            <YStack key={choice.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable selected={picking === choice.id} disabled={picking !== null} onPress={() => onPick(choice)}>
                <Row title={`${choice.label}${choice.recommended ? ' · likely this one' : ''}`} subtitle={choice.detail} />
              </Pressable>
            </YStack>
          ))}
        </Card>
      ) : null}
    </YStack>
  );
}

/**
 * A result that is waiting on a person: the QR code to scan, what to do, and
 * the same action asked again until it is done or the time runs out.
 */
function Waiting({ result, onAgain, onCancel }: { result: SetupActionResult; onAgain: (next: ConfigValues) => void; onCancel: () => void }) {
  const waiting = result.waiting!;
  const expired = Date.parse(waiting.until) <= Date.now();
  useEffect(() => {
    if (expired) return;
    const timer = setTimeout(() => onAgain(waiting.next), waiting.everyMs);
    return () => clearTimeout(timer);
  }, [expired, onAgain, waiting]);

  return (
    <Card gap="$4" alignItems="center" paddingVertical="$5">
      {waiting.qr && !expired ? (
        <YStack padding="$2" backgroundColor="#ffffff" borderRadius="$4">
          <QrCode value={waiting.qr} label="A code for your phone to scan" />
        </YStack>
      ) : null}
      <Text fontSize={14} color="$color" lineHeight={21} textAlign="center" maxWidth={380}>
        {expired ? 'The code has expired. Start again for a fresh one.' : result.detail}
      </Text>
      {expired ? null : (
        <XStack gap="$2" alignItems="center">
          <Spinner size="small" color="$accent" />
          <Text fontSize={12} color="$muted">
            Waiting for your phone…
          </Text>
        </XStack>
      )}
      <Button size="$2" chromeless color="$muted" onPress={onCancel}>
        {expired ? 'Start again' : 'Cancel'}
      </Button>
    </Card>
  );
}

/** One helper: its card, its own questions when it has any, and what it answers. */
function ActionCard({
  flow,
  stepId,
  action,
  primary,
  busy,
  setBusy,
  onDone,
}: {
  flow: SetupFlow;
  stepId: string;
  action: SetupActionView;
  primary: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** It filled something in, or the person picked one of its candidates. */
  onDone: (choice: SetupChoice | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<ConfigValues>({});
  const [result, setResult] = useState<SetupActionResult | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (values: ConfigValues) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await flow.action(stepId, action.id, values);
        if (!next.ok && !next.choices?.length) {
          // Refused: said beside the questions, which stay, to be corrected and asked again.
          setResult(null);
          setOpen(true);
          setError(next.detail);
          return;
        }
        setResult(next);
        // Filled in without a choice: done.
        if (next.ok && !next.waiting && !next.choices?.length && next.suggestedConfig) onDone(null);
      } catch (err) {
        setError(describeError(err) || 'That did not work');
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [action.id, flow, onDone, setBusy, stepId]
  );

  const asks = action.input && Object.keys(action.input.fields).length > 0;
  const ready = !asks || isComplete(action.input!, input);

  return (
    <Card gap="$3" borderWidth={primary ? 1 : 0} borderColor="$accent">
      <YStack gap="$1">
        <Text fontSize={16} fontWeight="700" color="$color">
          {action.label}
        </Text>
        {action.description ? (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {action.description}
          </Text>
        ) : null}
      </YStack>

      {result?.waiting ? (
        <Waiting result={result} onAgain={(next) => void run(next)} onCancel={() => setResult(null)} />
      ) : result?.choices?.length ? (
        <Choices
          result={result}
          picking={picking}
          onPick={(choice) => {
            setPicking(choice.id);
            onDone(choice);
          }}
        />
      ) : open || !asks ? (
        <YStack gap="$3">
          {asks ? (
            <Card inset backgroundColor="$background">
              <SchemaForm schema={action.input!} values={input} disabled={busy} onChange={(name, value) => setInput((before) => ({ ...before, [name]: value }))} />
            </Card>
          ) : null}
          <Button alignSelf="flex-start" size="$3" {...(primary ? PRIMARY : {})} disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void run(input)}>
            {busy ? 'Working…' : asks ? 'Continue' : action.label}
          </Button>
        </YStack>
      ) : (
        <Button alignSelf="flex-start" size="$3" {...(primary ? PRIMARY : {})} disabled={busy} onPress={() => setOpen(true)}>
          {action.label}
        </Button>
      )}
      <ErrorLine message={error} />
    </Card>
  );
}

function FormStep({ flow, step, onNext, onBack, onNamed }: StepProps & { step: Extract<SetupStepView, { kind: 'form' }>; onNamed: (name: string) => void }) {
  const current = () => (step.target === 'device' ? flow.device : flow.connection) as ConfigValues;
  const [values, setValues] = useState<ConfigValues>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = isComplete(step.schema, current(), flow.secrets);
  // With helpers, typing it all in is the fallback, one tap away — unless it is already filled.
  const [typing, setTyping] = useState(step.actions.length === 0 || filled);
  const theme = useTheme();

  const apply = (patch: ConfigValues) => flow.update(step.target === 'device' ? { device: patch } : { connection: patch });

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

  /** A helper's answer: its values, and — when it knows — where the device is and what it is called. */
  const done = (choice: SetupChoice | null) =>
    void run(async () => {
      if (choice) {
        await apply(choice.config);
        // A method with an address of its own has nothing to choose.
        if (choice.address && choice.address !== flow.address) {
          // Heard on the network: chosen as the list would; otherwise as if typed.
          await flow.choose({ address: choice.address }).catch(() => flow.choose({ manual: choice.address! }));
        }
        if (choice.name) onNamed(choice.name);
      }
      setValues(current());
      onNext();
    });

  return (
    <StepFrame
      title={step.title}
      description={step.description ?? step.schema.help}
      onBack={onBack}
      next={
        typing
          ? {
              label: 'Continue',
              disabled: busy || !isComplete(step.schema, values, flow.secrets),
              onPress: () =>
                void run(async () => {
                  await apply(values);
                  onNext();
                }),
            }
          : undefined
      }
    >
      {step.actions.map((action, index) => (
        <ActionCard key={action.id} flow={flow} stepId={step.id} action={action} primary={index === 0} busy={busy} setBusy={setBusy} onDone={done} />
      ))}

      {step.actions.length && !typing ? (
        <Pressable onPress={() => setTyping(true)}>
          <XStack alignItems="center" gap="$2" paddingHorizontal="$2" paddingVertical="$2">
            <Icon name="edit-3" size={14} color={theme.muted?.val} />
            <Text fontSize={13} color="$muted">
              I have them already — type them in
            </Text>
          </XStack>
        </Pressable>
      ) : null}

      {typing ? (
        <Card inset>
          <SchemaForm schema={step.schema} values={values} secretsSet={flow.secrets} disabled={busy} onChange={(name, value) => setValues((before) => ({ ...before, [name]: value }))} />
        </Card>
      ) : null}
      <ErrorLine message={error} />
    </StepFrame>
  );
}

function DiscoverStep({ flow, step, onNext, onBack }: StepProps & { step: Extract<SetupStepView, { kind: 'discover' }> }) {
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
    <StepFrame title={step.title} description={step.description} onBack={onBack} next={{ label: 'Skip', onPress: onNext }}>
      <Button alignSelf="flex-start" size="$3" {...PRIMARY} disabled={busy} onPress={() => void search()}>
        {busy ? 'Searching…' : 'Search'}
      </Button>
      {result ? (
        <Choices
          result={result}
          picking={null}
          onPick={(choice) => {
            void flow.update(step.target === 'device' ? { device: choice.config } : { connection: choice.config }).then(onNext);
          }}
        />
      ) : null}
    </StepFrame>
  );
}

// --- check ----------------------------------------------------------------------

function CheckStep({ flow, onChecked, onBack }: { flow: SetupFlow; onChecked: (outcome: CheckOutcome) => void; onBack: () => void }) {
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
    <StepFrame title="Check that it answers" onBack={onBack} next={!busy && error ? { label: 'Try again', onPress: () => void check() } : undefined}>
      <Card gap="$3">
        <XStack gap="$3" alignItems="center">
          {busy ? <Spinner color="$accent" /> : null}
          <Text fontSize={14} color={error ? '$danger' : '$color'} flex={1} lineHeight={20}>
            {busy ? 'Reading it once, to be sure it answers…' : (error ?? 'Checked.')}
          </Text>
        </XStack>
      </Card>
    </StepFrame>
  );
}
