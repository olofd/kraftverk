import type { Channel } from './channel.ts';
import { BRIDGE_TRANSPORT } from './bridge.ts';
import { isBridgedMethod, type ConnectionMethod } from './connection.ts';
import type { DeviceLogger, DeviceType, ScopedHttp } from './device-type.ts';
import type { Platform } from './node.ts';
import type { Protocol } from './protocol.ts';
import { personFields, type ConfigSchema, type ConfigValues } from './schema.ts';
import type { Sighting, TransportDefinition } from './transport.ts';

/**
 * Setup: how "I have one of these" becomes a device (docs/DATA-MODEL.md §1).
 *
 * A method's setup is **assembled from its layers**, not written whole by each
 * device type. The protocol's binding says what to do to the device first; the
 * transport finds it; the protocol asks for its credentials; the device type
 * adds what is its own and reads the device once to check it. So a device type
 * mostly declares "this protocol over mqtt", and improving a layer improves every
 * device that uses it.
 *
 * Every step runs in the holder: on the server for a connection the server will
 * hold, in the app for one the app will. The save is always the server's — or,
 * in local mode, the app's own storage — in one go.
 *
 * Nothing here is UI. A step is data the app can draw, plus, for steps that do
 * something, a function run where the connection will be held. The app receives
 * the steps without their functions (`setupPlan`), which is how a type added
 * next year needs no new screen.
 */

/**
 * One of several things the user might pick.
 *
 * Discovery nearly always ends the same way — *here are three devices, which is
 * yours?* — so that shape belongs in the contract. The app renders a list and
 * applies the chosen values to the draft.
 */
export type SetupChoice = {
  id: string;
  label: string;
  /** A second line: an address, a product name, a signal strength. */
  detail?: string;
  /** Applied to the draft when this one is chosen, to whichever part the step fills. */
  config: ConfigValues;
  /** Marks the option the step thinks is right. */
  recommended?: boolean;
  /**
   * Where the device is, when the helper knows: an account's device list
   * matched against what the transport sees. Chosen with it, so the step that
   * finds the device is already done.
   */
  address?: string;
  /** What its owner calls it, where the helper learnt that: offered as its name. */
  name?: string;
};

/**
 * Not done yet: a person has something to do first — scan a code with the
 * vendor's app, confirm on the device. The app shows `qr` (as a QR code) and
 * `detail`, and runs the same action again with `next` as its input every
 * `everyMs`, until an answer without `waiting` comes back or `until` passes.
 */
export type SetupWaiting = {
  /** Text to show as a QR code, for a phone to scan. */
  qr?: string;
  next: ConfigValues;
  everyMs: number;
  /** When to give up: an ISO time. */
  until: string;
};

export type SetupActionResult = {
  ok: boolean;
  /** One sentence for the user. */
  detail: string;
  /** Anything else worth showing: a datapoint dump, raw diagnostics. */
  data?: Record<string, unknown>;
  /** Several candidates to choose between. */
  choices?: readonly SetupChoice[];
  /**
   * A single unambiguous answer, applied without a choice.
   *
   * Secret fields may be filled here and in `choices`. The server keeps their
   * values and hands the app a short-lived placeholder instead, which saving
   * turns back into the secret: the value itself never reaches a browser.
   */
  suggestedConfig?: ConfigValues;
  /** Asked again after a person has done something: see `SetupWaiting`. */
  waiting?: SetupWaiting;
  /**
   * One more thing to ask the person before it is done — a code sent to a
   * phone, the PIN a TV shows. The app draws `schema` as a form inside the
   * step, and runs the same action again with what they give. `carry` is
   * what the next turn needs that is not theirs to see — a sign-in half
   * made: kept by whoever runs the setup, added to that next input, and never
   * sent to the app.
   */
  ask?: { schema: ConfigSchema; carry?: ConfigValues };
};

/** What a step's function can reach. */
export type SetupContext<Config extends ConfigValues = ConfigValues> = {
  /** The device's own config entered so far. Secrets are not in it. */
  draft: Partial<Config>;
  /** The connection's config entered or chosen so far. */
  connection: ConfigValues;
  /** The address chosen, once one has been. */
  address: string | null;
  /** Secrets entered or fetched so far, by field. */
  secrets: { get(field: string): string | null };
  /** For helpers that call a vendor's API once — fetching a key. Not for the device. */
  http: ScopedHttp;
  /**
   * What the transport sees now, for a helper that matches a vendor's list
   * against the network. Empty where nothing is watched (an app's chooser).
   */
  sightings: readonly Sighting[];
  log: DeviceLogger;
  /** Aborted when the user leaves the flow, or the step runs too long. */
  signal: AbortSignal;
  platform: Platform;
  /**
   * A channel to the device chosen, over its way's transport, for an action
   * that pairs with it: a PIN shown on its screen, asked for in a turn of its
   * own. The action keeps it open across its turns, and closes it. Absent
   * until a device is chosen, and for a way that reaches none of its own.
   */
  open?(): Promise<Channel>;
};

/** A button inside a step: "Fetch the key from the vendor's cloud". */
export type SetupAction<Config extends ConfigValues = ConfigValues> = {
  id: string;
  label: string;
  description?: string;
  /** What the action asks for, in the same form language as config. */
  input?: ConfigSchema;
  run(ctx: SetupContext<Config>, input: ConfigValues): Promise<SetupActionResult>;
};

type StepBase = {
  /** Unique within the flow; how the app and the server refer to the step. */
  id: string;
  title: string;
  description?: string;
};

/** Which part of the draft a form or a discovery fills. */
export type SetupTarget = 'device' | 'connection';

/** A step a device type or a protocol writes. */
export type SetupStep<Config extends ConfigValues = ConfigValues> =
  /** Something the user does with their hands: "put the plug in pairing mode". */
  | (StepBase & { kind: 'instructions'; body: string; image?: string })
  /** Finds candidates and offers them as choices. */
  | (StepBase & {
      kind: 'discover';
      target: SetupTarget;
      run(ctx: SetupContext<Config>): Promise<SetupActionResult>;
    })
  /** Asks for some fields, with helper actions beside them. */
  | (StepBase & {
      kind: 'form';
      target: SetupTarget;
      /** The fields asked for. The device type's config, or the connection's. */
      schema: ConfigSchema;
      actions?: readonly SetupAction<Config>[];
    });

// --- what the app is sent ------------------------------------------------------

export type SetupActionView = Omit<SetupAction, 'run'>;

/**
 * A step as data: everything but the functions.
 *
 * Two kinds only the core writes. `choose` is the transport's: find the one
 * physical device — a live list, the platform's own chooser, or an address
 * typed by hand. `check` reads the device once through the type's `identify`,
 * and is always last.
 */
export type SetupStepView =
  | (StepBase & { kind: 'instructions'; body: string; image?: string })
  | (StepBase & { kind: 'discover'; target: SetupTarget })
  | (StepBase & { kind: 'form'; target: SetupTarget; schema: ConfigSchema; actions: readonly SetupActionView[] })
  | (StepBase & {
      kind: 'choose';
      transport: string;
      discovery: 'list' | 'chooser' | 'none';
      /** When an address may be typed, what it is called: "IP address". */
      manual: string | null;
    })
  | (StepBase & {
      kind: 'check';
      /** Present when saving after a failed check is reasonable for this type, and why. */
      saveAnyway: string | null;
    });

const viewOf = (step: SetupStep<any>): SetupStepView => {
  const base = { id: step.id, title: step.title, ...(step.description ? { description: step.description } : {}) };
  switch (step.kind) {
    case 'instructions':
      return { ...base, kind: 'instructions', body: step.body, ...(step.image ? { image: step.image } : {}) };
    case 'discover':
      return { ...base, kind: 'discover', target: step.target };
    case 'form':
      return {
        ...base,
        kind: 'form',
        target: step.target,
        schema: step.schema,
        actions: (step.actions ?? []).map(({ run: _run, ...action }) => action),
      };
  }
};

/** Fills `{name}` placeholders from a transport's values; unknown names stay as they are. */
export const fillValues = (text: string, values: Readonly<Record<string, string>>): string =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

export type SetupPlanInput = {
  type: DeviceType<any>;
  /** Null for a type that has no connection to set up. */
  method: ConnectionMethod | null;
  protocol: Protocol | null;
  transport: TransportDefinition | null;
  /** Where the connection will be held: decides how the device is chosen. */
  platform: Platform;
  /** The transport's values, for instructions: the broker's address. */
  values?: Readonly<Record<string, string>>;
};

/**
 * Every step of setting up one method, in order, as the app draws them.
 *
 * Get it ready (the binding's instructions) → choose the device (the transport)
 * → credentials (the protocol) → the method's own config and steps → the type's
 * own steps → check (the type's `identify`). Naming the device and linking it
 * come after, and are the core's.
 */
export function setupPlan(input: SetupPlanInput): SetupStepView[] {
  const { type, method, protocol, transport, platform } = input;
  const steps: SetupStepView[] = [];
  // A way over a transport has its protocol's binding and credentials; one through a bridge, neither.
  const direct = method && !isBridgedMethod(method) ? method : null;
  const binding = direct && protocol ? protocol.bindings[direct.transport] : undefined;

  if (binding?.instructions) {
    steps.push({
      id: 'ready',
      kind: 'instructions',
      title: binding.instructions.title,
      body: fillValues(binding.instructions.body, input.values ?? {}),
    });
  }

  // A way through a bridge is signed in as the bridge is: no credentials step of its own.
  const credentials =
    direct && protocol?.credentials && Object.keys(protocol.credentials.schema.fields).length
      ? viewOf({
          id: 'credentials',
          kind: 'form',
          target: 'connection',
          title: protocol.credentials.title ?? 'Credentials',
          schema: personFields(protocol.credentials.schema),
          actions: protocol.credentials.actions,
        })
      : null;

  // An account that lists the devices comes first: signing in is how the device is found.
  if (credentials && protocol?.credentials?.first) steps.push(credentials);

  if (direct && transport && !direct.address) {
    const discovery = transport.discovery[platform] ?? 'none';
    steps.push({
      id: 'choose',
      kind: 'choose',
      title: `Find your ${type.meta.name}`,
      transport: transport.id,
      discovery,
      manual: binding?.parseAddress ? (binding.addressLabel ?? 'Address') : null,
    });
  } else if (method && isBridgedMethod(method)) {
    // Through a bridge: which of its members it is, from the bridge's own list. Never typed.
    steps.push({ id: 'choose', kind: 'choose', title: `Find your ${type.meta.name}`, transport: BRIDGE_TRANSPORT, discovery: 'list', manual: null });
  }

  if (credentials && !protocol?.credentials?.first) steps.push(credentials);

  if (method?.config && Object.keys(method.config.fields).length) {
    steps.push(viewOf({ id: 'connection', kind: 'form', target: 'connection', title: 'Connection', schema: method.config }));
  }

  for (const step of method?.steps ?? []) steps.push(viewOf(step));
  for (const step of type.setup?.steps ?? []) steps.push(viewOf(step));

  steps.push({
    id: 'check',
    kind: 'check',
    title: 'Check that it answers',
    saveAnyway: type.setup?.saveAnyway ?? null,
  });
  return steps;
}

/** The step with this id among a type's own steps and a method's, with its function. */
export function findStep(type: DeviceType<any>, method: ConnectionMethod | null, protocol: Protocol | null, id: string) {
  if (id === 'credentials' && protocol?.credentials) {
    return {
      kind: 'form' as const,
      id,
      title: protocol.credentials.title ?? 'Credentials',
      target: 'connection' as const,
      schema: personFields(protocol.credentials.schema),
      actions: protocol.credentials.actions,
    };
  }
  return [...(method?.steps ?? []), ...(type.setup?.steps ?? [])].find((step) => step.id === id) ?? null;
}
