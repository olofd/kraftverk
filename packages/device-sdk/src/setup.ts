import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { DeviceLogger, ScopedHttp, TransportRuntime } from './device-type.ts';

/**
 * Setup guides: how a device type turns "I have one of these" into a working
 * device, written in code by the type and rendered by the app with one wizard.
 *
 * The steps run against a **draft** — config not yet saved, secrets held by the
 * server — and the device is created only when a `verify` step passes, or when
 * the user takes the guide's "save anyway" for a failure it expects (a station
 * that is asleep). So a saved device is one that has worked, or one the user
 * knowingly saved before it could.
 *
 * Nothing here is UI. A step is data the app can draw — a title, some text, a
 * list of fields from the type's config schema — plus, for the steps that do
 * something, a function the server runs. The app receives the steps without
 * their functions (`describeSetup`), which is how a guide added next year needs
 * no new screen.
 */

/**
 * One of several things the user might pick.
 *
 * Discovery nearly always ends the same way — *here are three devices, which is
 * yours?* — so that shape belongs in the contract. The app renders a list and
 * writes the chosen `config` into the draft; it needs to know nothing about
 * what is being chosen.
 */
export type SetupChoice = {
  id: string;
  label: string;
  /** A second line: an address, a product name, a signal strength. */
  detail?: string;
  /** Applied to the draft when this one is chosen. */
  config: ConfigValues;
  /** Marks the option the device type thinks is right. */
  recommended?: boolean;
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
};

/** What a step's function can reach: the draft, and the server's facilities. */
export type SetupContext<Config extends ConfigValues = ConfigValues> = {
  /** Everything entered or chosen so far. Secrets are not in it; see `secrets`. */
  draft: Partial<Config>;
  /** Secrets entered or fetched so far, by config field. */
  secrets: { get(field: string): string | null };
  http: ScopedHttp;
  transports: TransportRuntime;
  log: DeviceLogger;
  /** Aborted when the user leaves the guide, or the step runs too long. */
  signal: AbortSignal;
};

/** A button inside a step: "Fetch the key from the Tuya cloud". */
export type SetupAction<Config extends ConfigValues = ConfigValues> = {
  id: string;
  label: string;
  description?: string;
  /** What the action asks for, in the same form language as config. */
  input?: ConfigSchema;
  run(ctx: SetupContext<Config>, input: ConfigValues): Promise<SetupActionResult>;
};

type StepBase = {
  /** Unique within the guide; how the app and the server refer to the step. */
  id: string;
  title: string;
  description?: string;
};

export type SetupStep<Config extends ConfigValues = ConfigValues> =
  /** Something the user does with their hands: "put the plug in pairing mode". */
  | (StepBase & { kind: 'instructions'; body: string; image?: string })
  /** Finds candidates — on the network, on the radio — and offers them as choices. */
  | (StepBase & { kind: 'discover'; run(ctx: SetupContext<Config>): Promise<SetupActionResult> })
  /** Asks for some of the config fields, with helper actions beside them. */
  | (StepBase & {
      kind: 'form';
      fields: readonly (keyof Config & string)[];
      actions?: readonly SetupAction<Config>[];
    })
  /**
   * Proves the draft works: connect, read once, switch nothing.
   *
   * `saveAnyway`, when present, is the sentence explaining why saving after a
   * failure is reasonable for this type — and its presence is what offers it.
   */
  | (StepBase & {
      kind: 'verify';
      run(ctx: SetupContext<Config>): Promise<SetupActionResult>;
      saveAnyway?: string;
    });

export type SetupGuide<Config extends ConfigValues = ConfigValues> = {
  steps: readonly SetupStep<Config>[];
};

// --- what the app is sent -----------------------------------------------------

export type SetupActionView = Omit<SetupAction, 'run'>;

/** A step as data: everything but the functions. */
export type SetupStepView =
  | (StepBase & { kind: 'instructions'; body: string; image?: string })
  | (StepBase & { kind: 'discover' })
  | (StepBase & { kind: 'form'; fields: readonly string[]; actions: readonly SetupActionView[] })
  | (StepBase & { kind: 'verify'; saveAnyway: string | null });

export function describeSetup(guide: SetupGuide<any>): SetupStepView[] {
  return guide.steps.map((step): SetupStepView => {
    const base = { id: step.id, title: step.title, ...(step.description ? { description: step.description } : {}) };
    switch (step.kind) {
      case 'instructions':
        return { ...base, kind: 'instructions', body: step.body, ...(step.image ? { image: step.image } : {}) };
      case 'discover':
        return { ...base, kind: 'discover' };
      case 'form':
        return {
          ...base,
          kind: 'form',
          fields: [...step.fields],
          actions: (step.actions ?? []).map(({ run: _run, ...action }) => action),
        };
      case 'verify':
        return { ...base, kind: 'verify', saveAnyway: step.saveAnyway ?? null };
    }
  });
}
