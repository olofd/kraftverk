import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Input, Spinner } from 'tamagui';

import { SetupFlow, typeMatches, type CheckOutcome } from '@kraftverk/api-client';
import { Card, haptic } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { useAttempt } from '../../components/useAttempt';
import { HERE } from '../../platform/here';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { useReach } from '../../state/useReach';
import { Categories } from './Categories';
import { Finish } from './Finish';
import { Outcome } from './Outcome';
import { Progress } from './Progress';
import { StepView } from './steps/StepView';
import { Types } from './Types';
import { Ways, type Way } from './Ways';

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

export function AddDevice() {
  const params = useLocalSearchParams<{ type?: string; method?: string; address?: string; attach?: string }>();
  const { devices, refresh } = useDevices();
  const { api, role } = useHome();
  const reach = useReach();
  const attachTo = params.attach ? (devices.find((device) => device.id === params.attach) ?? null) : null;

  // What can be added: the home's installed types, and whether it can hold each way.
  const { value: types, error: loadError } = useAnswer(() => api.deviceTypes().then((list) => list.types), [api], { failure: 'What can be added could not be read' });
  const [stage, setStage] = useState<Stage>(params.type ? 'method' : 'category');
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeId, setTypeId] = useState<string | null>(params.type ?? null);
  const [flow, setFlow] = useState<SetupFlow | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  /** What a helper learnt the device is called — its name in its maker's app — offered when it is named. */
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  const { busy, error, attempt } = useAttempt();
  const flowRef = useRef<SetupFlow | null>(null);

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
          label: `${method.label}, ${reach.holder(way.holder).words}`,
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
      await attempt(async () => {
        flowRef.current?.discard();
        const next: SetupFlow = await SetupFlow.start(api, type.id, way.methodId, way.holder);
        flowRef.current = next;
        setFlow(next);
        setStepIndex(0);
        setOutcome(null);
        setSuggestedName(null);
        setStage('steps');
      }, 'That way cannot be used right now');
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
    setStepIndex((index) => flow.after(index));
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
    setStepIndex(flow.before(stepIndex));
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
          <ErrorText>
            {loadError}
          </ErrorText>
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
              types={types.filter((candidate) => typeMatches(candidate, query))}
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
              .map((step, index) => ({ title: step.title, index, skipped: flow.skips(index) && index !== stepIndex }))
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
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </Screen>
  );
}

// --- 1 · what are you adding ------------------------------------------------------

