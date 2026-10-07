import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Input, Spinner } from 'tamagui';

import { PATHS, pathOf, SetupFlow, typeMatches, waySaid, type CheckOutcome, type DeviceTypeListing, type HeldBy, type SetupFrom } from '@kraftverk/api-client';
import { CATEGORIES, isIntegrationsOwn, SIMULATED_METHOD_ID } from '@kraftverk/device-sdk';
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
import { doneWith, dropFlow, keepFlow, nameFound, namedIn, useFlow } from './flows';
import { Outcome } from './Outcome';
import { Progress } from './Progress';
import { StepView } from './steps/StepView';
import { Types } from './Types';
import { Ways, type Way } from './Ways';

/*
  Adding a device, a service — or, from its integration's page, an account
  or a gateway (docs/DATA-MODEL.md §1), each stage at an address of its own
  (`PATHS`): its shelves → what is on one → how it is reached → the steps
  that way's layers supply, one page each → the check → a name, and how it
  fits the house → saved. Every step that touches the device runs where the
  connection will be held: the home — a server, or the app's own — or this
  app, for a server.
*/

type Shelf = 'devices' | 'services';

/** What a person calls what they are adding, by its kind. */
const KIND_WORD: Readonly<Record<DeviceTypeListing['kind'], string>> = { hardware: 'device', service: 'service', account: 'account', gateway: 'gateway' };
const adding = (kind: DeviceTypeListing['kind']) => `Add ${kind === 'account' ? 'an' : 'a'} ${KIND_WORD[kind]}`;

/** The home's installed types, and whether it can hold each way. */
function useTypes() {
  const { api } = useHome();
  const { value, error } = useAnswer(() => api.deviceTypes().then((list) => list.types), [api], { failure: 'What can be added could not be read' });
  return { types: value ?? null, error };
}

/** A shelf's types: devices, or services. An account or a gateway is never listed: it is opened at its type from its integration's page. */
const onShelf = (types: readonly DeviceTypeListing[], shelf: Shelf) => types.filter((type) => type.kind === (shelf === 'services' ? 'service' : 'hardware'));

const addOn = (shelf: Shelf) => (shelf === 'services' ? PATHS.services.add : PATHS.devices.add);

function Loading({ error }: { error: string | null }) {
  return error ? (
    <Card borderColor="$danger">
      <ErrorText>{error}</ErrorText>
    </Card>
  ) : (
    <Spinner color="$accent" />
  );
}

// --- 1 · what are you adding: /devices/add, /services/add ----------------------------

export function ShelfScreen({ shelf }: { shelf: Shelf }) {
  const { types, error } = useTypes();
  const [query, setQuery] = useState('');
  const listed = onShelf(types ?? [], shelf);
  const label = shelf === 'services' ? 'Search by name' : 'Search by brand or model';
  return (
    <Screen back="Your devices" backTo={PATHS.home} title={shelf === 'services' ? 'Add a service' : 'Add a device'}>
      {!types ? <Loading error={error} /> : null}
      {types ? (
        <>
          <Input size="$3" value={query} placeholder={label} autoCapitalize="none" onChangeText={setQuery} backgroundColor="$background" borderColor="$borderColor" aria-label={label} />
          {query.trim() ? (
            <Types types={listed.filter((candidate) => typeMatches(candidate, query))} onPick={(id) => router.push(PATHS.add(id))} onBack={() => setQuery('')} />
          ) : (
            <Categories types={listed} shelf={shelf} onPick={(id) => router.push(addOn(shelf)(id))} />
          )}
        </>
      ) : null}
    </Screen>
  );
}

// --- 2 · which one: /devices/add/<category> ---------------------------------------------

export function CategoryScreen({ shelf }: { shelf: Shelf }) {
  const { category } = useLocalSearchParams<{ category: string }>();
  const { types, error } = useTypes();
  return (
    <Screen
      back={shelf === 'services' ? 'Add a service' : 'Add a device'}
      backTo={addOn(shelf)()}
      title={CATEGORIES[category as keyof typeof CATEGORIES]?.label ?? (shelf === 'services' ? 'Add a service' : 'Add a device')}
    >
      {!types ? <Loading error={error} /> : null}
      {types ? (
        <Types
          types={onShelf(types, shelf).filter((candidate) => candidate.meta.category === category)}
          onPick={(id) => router.push(PATHS.add(id))}
          onBack={() => (router.canGoBack() ? router.back() : router.replace(addOn(shelf)()))}
        />
      ) : null}
    </Screen>
  );
}

// --- 3 · how do you want to connect: /add/<type>, /devices/<id>/ways/add ----------------------

/** The ways to reach a type — for a device you have, another way to reach it (`/devices/<id>/ways/add`). */
export function WaysScreen() {
  const params = useLocalSearchParams<{ type?: string; id?: string; method?: string; address?: string; through?: string }>();
  const { devices } = useDevices();
  const { api, role } = useHome();
  const reach = useReach();
  const { types, error: loadError } = useTypes();
  const { busy, error, attempt } = useAttempt();
  // Another way to reach a device you have: its type, and it to attach the way to.
  const attachTo = params.id ? (devices.find((device) => device.id === params.id) ?? null) : null;
  const typeId = params.type ?? attachTo?.typeId ?? null;
  const type = types?.find((candidate) => candidate.id === typeId) ?? null;

  const ways = useMemo((): Way[] => {
    if (!type) return [];
    /*
      Every way the home offers, in its type's order: the home's own —
      through your server, or from where the app keeps its own — and, with a
      server, this app's own radio for it. Each says whether it can be used
      now, and why not.
    */
    // Who would hold it is said only where there is a choice: through your server, or in this app.
    const holders = new Set(type.ways.map((way) => way.holder));
    return type.connections.flatMap((method): Way[] =>
      type.ways
        .filter((way) => way.method === method.id)
        .map((way) => {
          // Reached through an account or a gateway you do not have yet: that comes first, and is a step to take, not a dead end.
          const bridges = method.through ?? [];
          const haveOne = devices.some((device) => bridges.includes(device.typeId) && !device.removedAt);
          const needed = bridges.length && !haveOne ? (types?.find((candidate) => candidate.id === bridges[0]) ?? null) : null;
          return {
            methodId: method.id,
            label: holders.size > 1 ? `${method.label}, ${reach.holder(way.holder).words}` : method.label,
            description: way.holder === 'this-node' ? `While ${HERE} has it: kept by your server, which hears what it says when it can.` : method.description,
            // A simulator reaches nothing: what it is is said by its description alone.
            reaches: method.id === SIMULATED_METHOD_ID ? '' : waySaid(method),
            holder: way.holder,
            available: way.availability.ok,
            reason: way.availability.ok ? null : way.availability.reason,
            recommended: way.holder === 'master' && Boolean(method.recommended),
            ...(needed ? { needs: { typeId: needed.id, name: needed.meta.name, kind: needed.kind } } : {}),
          };
        })
    );
  }, [devices, reach, role, type, types]);

  const begin = useCallback(
    async (way: Way) => {
      if (!type) return;
      haptic();
      await attempt(async () => {
        const flow = await SetupFlow.start(api, type.id, way.methodId, way.holder);
        keepFlow(flow);
        router.push(
          PATHS.setup(flow.id, flow.plan[0]!.id, {
            ...(attachTo ? { attach: attachTo.id } : {}),
            ...(params.address ? { address: params.address } : {}),
            ...(params.through ? { through: params.through } : {}),
            ...(way.holder === 'this-node' ? { held: 'here' as const } : {}),
          })
        );
      }, 'That way cannot be used right now');
    },
    [api, attachTo, attempt, params.address, params.through, type]
  );

  // "Found near you" names the way too: started straight away.
  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || !params.method || !type) return;
    const way = ways.find((candidate) => candidate.methodId === params.method && candidate.holder === 'master' && candidate.available);
    if (!way) return;
    autostarted.current = true;
    void begin(way);
  }, [begin, params.method, type, ways]);

  // Back to where it was asked from: its device, its integration's page, or the shelf it is on.
  const own = type && isIntegrationsOwn(type.kind) ? type.source.integration : null;
  const back = attachTo
    ? { label: attachTo.name, to: PATHS.devices.settings(attachTo.id) }
    : own
      ? { label: own.name, to: PATHS.integrations.one(own.id) }
      : type
        ? { label: type.kind === 'service' ? 'Add a service' : 'Add a device', to: addOn(type.kind === 'service' ? 'services' : 'devices')(type.meta.category) }
        : { label: 'Your devices', to: PATHS.home };

  return (
    <Screen back={back.label} backTo={back.to} title={attachTo ? `Another way to reach ${attachTo.name}` : type ? adding(type.kind) : 'Add'} subtitle={type?.meta.name}>
      {!types ? <Loading error={loadError} /> : null}
      {types && !type ? (
        <Card>
          <ErrorText>Nothing installed here is called “{typeId}”.</ErrorText>
        </Card>
      ) : null}
      {type ? <Ways ways={ways} busy={busy} onPick={(way) => void begin(way)} onNeed={(need) => router.push(PATHS.add(need.typeId))} /> : null}
      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </Screen>
  );
}

// --- one of a device's ways, set up again: /devices/<id>/ways/<connection>/again ----------

export function AgainScreen() {
  const { id, connection } = useLocalSearchParams<{ id: string; connection: string }>();
  const { api } = useHome();
  const { busy, error, attempt } = useAttempt();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void attempt(async () => {
      const flow = await SetupFlow.again(api, id, connection);
      keepFlow(flow);
      router.replace(PATHS.setup(flow.id, flow.plan[0]!.id));
    }, 'It cannot be set up again right now');
  }, [api, attempt, connection, id]);
  return (
    <Screen back="Back" backTo={PATHS.devices.one(id)} title="Set up again">
      {busy ? <Spinner color="$accent" /> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Screen>
  );
}

// --- 4 · its steps, one page each: /setup/<draft>/<step> -----------------------------------

/** After the check: naming it, and how it fits the house. Not one of the plan's steps. */
const NAME_STEP = 'name';

export function SetupScreen() {
  const params = useLocalSearchParams<{ draft: string; step?: string; attach?: string; address?: string; through?: string; held?: string }>();
  const { devices, refresh } = useDevices();
  const { api } = useHome();
  const { types } = useTypes();
  const holder: HeldBy = params.held === 'here' ? 'this-node' : 'master';
  const { flow, error: lost } = useFlow(api, params.draft, holder);
  const { error, attempt } = useAttempt();
  const type = flow ? (types?.find((candidate) => candidate.id === flow.typeId) ?? null) : null;
  const attachTo = params.attach ? (devices.find((device) => device.id === params.attach) ?? null) : null;
  const carried: Pick<SetupFrom, 'attach' | 'address' | 'through' | 'held'> = {
    ...(params.attach ? { attach: params.attach } : {}),
    ...(params.address ? { address: params.address } : {}),
    ...(params.through ? { through: params.through } : {}),
    ...(params.held === 'here' ? { held: 'here' as const } : {}),
  };
  const at = (step: string) => PATHS.setup(params.draft, step, carried);

  // Where it is: a step of its plan, or naming it after the check. None named: the first.
  const naming = params.step === NAME_STEP;
  const stepIndex = flow ? Math.max(0, flow.plan.findIndex((step) => step.id === params.step)) : 0;
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  // Taken up again at the check, or come back to it: what it found is shown, not asked for again.
  useEffect(() => {
    if (flow && flow.plan[stepIndex]?.kind === 'check') setOutcome(flow.checked);
  }, [flow, stepIndex]);
  useEffect(() => {
    if (flow && !params.step) router.replace(at(flow.plan[0]!.id));
  });

  const again = flow?.again ?? null;
  const title = again ? `Sign ${again.name} in again` : attachTo ? `Another way to reach ${attachTo.name}` : type ? adding(type.kind) : 'Setting up';
  const waysOf = flow ? (attachTo ? PATHS.devices.addWay(attachTo.id) : PATHS.add(flow.typeId)) : PATHS.home;

  /** Forward. Finding the device on the network is skipped when an earlier step already found it. */
  const next = useCallback(() => {
    if (!flow) return;
    router.push(at(flow.plan[flow.after(stepIndex)]!.id));
  }, [flow, stepIndex]);

  /** Back one step, keeping everything entered; from the first, back to choosing how to connect, the draft let go. */
  const back = useCallback(() => {
    if (!flow) return;
    haptic();
    if (stepIndex === 0) {
      dropFlow(flow.id);
      router.replace(waysOf);
      return;
    }
    flow.uncheck();
    router.replace(at(flow.plan[flow.before(stepIndex)]!.id));
  }, [flow, stepIndex, waysOf]);

  /** Saved over the way it set up again — nothing added — and back to what it is a way of. */
  const saveAgain = useCallback(async () => {
    if (!flow || !again) return;
    await attempt(async () => {
      await flow.save({ name: again.name });
      doneWith(flow.id);
      await refresh();
      const thing = devices.find((device) => device.id === again.deviceId);
      router.replace(thing ? pathOf(thing) : PATHS.devices.one(again.deviceId));
    }, 'It could not be saved');
  }, [again, attempt, devices, flow, refresh]);

  if (lost || !flow) {
    return (
      <Screen back="Your devices" backTo={PATHS.home} title="Setting up">
        {lost ? <ErrorText>{lost}</ErrorText> : <Spinner color="$accent" />}
      </Screen>
    );
  }

  const step = flow.plan[stepIndex]!;
  return (
    <Screen back={attachTo ? attachTo.name : type ? (type.kind === 'service' ? 'Add a service' : 'Add a device') : 'Back'} backTo={waysOf} title={title} subtitle={type?.meta.name}>
      <Progress
        steps={[
          ...flow.plan.map((each, index) => ({ title: each.title, index, skipped: flow.skips(index) && index !== stepIndex })).filter((each) => !each.skipped),
          ...(again ? [] : [{ title: attachTo ? 'Add it' : 'Name it', index: flow.plan.length }]),
        ]}
        at={naming ? flow.plan.length : stepIndex}
        onGoTo={(index) => {
          haptic();
          flow.uncheck();
          router.push(at(index >= flow.plan.length ? NAME_STEP : flow.plan[index]!.id));
        }}
      />

      {!naming && step.kind === 'check' && outcome ? (
        <Outcome
          outcome={outcome}
          attachTo={attachTo}
          earlier={flow.plan.length > 1}
          onBack={() => {
            // To the step before the check; with none, to choosing how to reach it.
            flow.uncheck();
            setOutcome(null);
            if (flow.plan.length > 1) router.replace(at(flow.plan[flow.before(stepIndex)]!.id));
            else back();
          }}
          onRetry={() => (flow.uncheck(), setOutcome(null))}
          onContinue={() => (again ? void saveAgain() : router.push(at(NAME_STEP)))}
          onOtherType={(id) => (dropFlow(flow.id), router.replace(PATHS.add(id)))}
        />
      ) : null}

      {!naming && !(step.kind === 'check' && outcome) ? (
        <StepView
          key={step.id}
          flow={flow}
          step={step}
          presetAddress={params.address}
          presetThrough={params.through}
          onNext={next}
          onBack={back}
          onChecked={setOutcome}
          onNamed={(name) => nameFound(flow.id, name)}
        />
      ) : null}

      {naming && flow.checked && type ? (
        <Finish
          flow={flow}
          outcome={flow.checked}
          onBack={() => router.replace(at(flow.plan[flow.plan.length - 1]!.id))}
          typeName={namedIn(flow.id) ?? type.meta.name}
          description={type.description}
          attachTo={attachTo}
          devices={devices}
          onSaved={async (id) => {
            doneWith(flow.id);
            await refresh();
            router.replace(pathOf({ id, kind: type.kind, integration: type.source.integration }));
          }}
        />
      ) : null}
      {naming && !flow.checked ? <ErrorText>It has not been checked yet: go back to the check.</ErrorText> : null}

      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </Screen>
  );
}
