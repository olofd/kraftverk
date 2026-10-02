import { ApiError, type ConfigExported, type ConfigExportRequest, type ImportAnswers, type ImportApplied, type ImportPlan } from '@kraftverk/api-contract';
import type { AuditRecord } from '@kraftverk/device-sdk';
import { Confirmations, subjectOf } from '@kraftverk/gateway';
import type { LiveBus } from '@kraftverk/holder';
import { configJsonSchema, readConfig, writeConfig, type Vocabulary } from '@kraftverk/home-file';

import { exportConfig, homeVocabulary } from './export.ts';
import { applyImport, keptPlan, PendingPlans, planImport, type ImportDeps, type ImportMode } from './import.ts';
import { restoreFrom, type Restored } from './restore.ts';
import { PASSPHRASE_MIN } from '@kraftverk/home-file';

/*
  A home's configuration (docs/CONFIG.md), as everything that uses a home
  asks for it: what a file may name, the JSON Schema an editor checks one
  against, an export, an import in two steps — the plan, then its apply with
  a person's yes where it sets something acting or takes something away —
  a restore after a reset, and the copy kept beside the database. The
  timeline and the live stream hear what it changed. Where the copy is kept,
  and the file a restore reads, are the place's.
*/

export type ConfigurationDeps = Omit<ImportDeps, 'pending'> & {
  record: (entry: AuditRecord) => void;
  /** Where a screen hears what an import changed. */
  bus?: LiveBus;
};

/** The timeline's kinds that change the configuration: a run, a tool, a reading do not. */
const CHANGES = new RegExp(
  '^(' +
    [
      'device\\.(added|restored|removed|renamed|identified|picture|linked|unlinked|connection-added|connection-removed|connection-preferred|secrets-changed|saved-unchecked|keyed|exportable)',
      'automation\\.(created|changed|armed|deleted|placed)',
      'policy\\.changed',
      'config\\.(imported|restored)',
    ].join('|') +
    ')$'
);

/** Whether an entry on the timeline changed the configuration: what the copy kept beside the database is written again after. */
export const changesConfiguration = (kind: string): boolean => CHANGES.test(kind);

/** The heading of the copy kept beside the database. */
const KEPT_HEADING = [
  'Kept by kraftverk beside its database, and written again after every change to it.',
  'When a new schema sets the database aside, it is restored from this file.',
  'Its secrets are sealed with this home\'s key, or kept as the database keeps them: it never leaves.',
].join('\n');

export class Configuration {
  readonly #deps: ImportDeps & ConfigurationDeps;
  /** A yes to what an import sets acting or takes away: a token bound to the plan, what is chosen, and the person, once. */
  readonly #confirming = new Confirmations();

  constructor(deps: ConfigurationDeps) {
    this.#deps = { ...deps, pending: new PendingPlans() };
  }

  /** What a configuration may name here — the installed types, and the keys of what you have: what an editor in the app checks against. */
  vocabulary(): Vocabulary {
    return homeVocabulary(this.#deps);
  }

  /** The JSON Schema of a file: the installed types, their settings, ways and secrets — nothing you have, as anyone may ask for it. */
  schema(): unknown {
    const { devices: _devices, automations: _automations, ...installed } = this.vocabulary();
    return configJsonSchema({ ...installed, devices: [], automations: [] });
  }

  /**
   * What you have, as a file: everything, or the devices and automations
   * chosen by key — and what could not go in. Secrets left out, sealed with a
   * passphrase, or in plain text where their owner allowed it; one that
   * carries them is on the timeline. `schemaUrl`: where an editor finds the
   * schema, for the file's first line.
   */
  async export(request: ConfigExportRequest, by: string, options: { schemaUrl?: string } = {}): Promise<ConfigExported> {
    const secrets = request.secrets ?? 'none';
    if (secrets === 'sealed' && (request.passphrase ?? '').length < PASSPHRASE_MIN) {
      throw new ApiError('invalid', `A passphrase is at least ${PASSPHRASE_MIN} characters: an export travels`);
    }
    const exported = await this.document(request);
    const text = writeConfig(exported.document, {
      ...exported.context,
      ...(options.schemaUrl ? { schemaUrl: options.schemaUrl } : {}),
      heading: [`Exported from kraftverk, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ...exported.notes.map((note) => `- ${note}`)].join('\n'),
    });
    if (secrets !== 'none') {
      this.#deps.record({
        at: new Date().toISOString(),
        kind: 'config.exported',
        actor: by,
        summary: `Exported the configuration with its secrets ${secrets === 'sealed' ? 'sealed with a passphrase' : 'in plain text'}`,
        detail: { devices: Object.keys(exported.document.devices), automations: Object.keys(exported.document.automations) },
      });
    }
    return { text, notes: exported.notes };
  }

  /**
   * What you have as a document, as an export writes it, before it is text:
   * what a home moving elsewhere is made into (`handover/`).
   */
  async document(request: ConfigExportRequest): Promise<Awaited<ReturnType<typeof exportConfig>>> {
    return exportConfig(this.#deps, { devices: request.devices, automations: request.automations, secrets: request.secrets ?? 'none', passphrase: request.passphrase });
  }

  /**
   * What importing a file would do — nothing yet done: its problems with
   * their lines, what becomes of each device, link, automation and home
   * value, and what it still needs. `replace`: what the file does not have is
   * removed. `kept`: the file is a copy this home kept, its secrets sealed
   * with its own key. `lenient`: planned as a restore is — what it cannot
   * carry is left out and said, never asked for — and applied so.
   */
  plan(text: string, options: { mode: ImportMode; passphrase?: string; kept?: boolean; lenient?: boolean }, by: string): Promise<ImportPlan> {
    return planImport(this.#deps, text, { ...options, by });
  }

  /**
   * Applies a plan with its answers — secrets it did not carry, a device of
   * yours for each role naming one you do not have, only some of it — in one
   * transaction. What it sets acting on its own, or removes, wants a
   * person's yes: refused with a token to send back as `confirmation`.
   */
  async apply(answers: ImportAnswers, by: string): Promise<ImportApplied> {
    const plan = keptPlan(this.#deps, answers.plan, by);
    if (!plan) throw new ApiError('not-found', 'That plan has gone: read the file again');
    // What it asks a yes to is asked whatever part of it is applied: a yes is not narrowed by the person's own choice of what to leave out.
    const asked = plan.needs.confirm;
    const subject = subjectOf({ plan: answers.plan, include: answers.include ?? null, by });
    if (asked.length && !this.#confirming.accept(answers.confirmation, subject)) {
      throw new ApiError('needs-yes', asked.join('. '), { needsConfirmation: this.#confirming.ask(subject) });
    }
    const applied = await applyImport(this.#deps, answers.plan, by, { include: answers.include, secrets: answers.secrets, rebind: answers.rebind }).catch((error: unknown) => {
      // Whatever stopped it — a value out of its range, a row the database would not keep — nothing was written: said as a refusal.
      throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
    });
    this.#deps.record({
      at: new Date().toISOString(),
      kind: 'config.imported',
      actor: by,
      summary: `Imported a configuration: ${[
        applied.devices.added.length && `${applied.devices.added.length} devices added`,
        applied.devices.restored.length && `${applied.devices.restored.length} brought back`,
        applied.devices.changed.length && `${applied.devices.changed.length} changed`,
        applied.devices.removed.length && `${applied.devices.removed.length} removed`,
        applied.automations.added.length && `${applied.automations.added.length} automations added`,
        applied.automations.changed.length && `${applied.automations.changed.length} changed`,
        applied.automations.removed.length && `${applied.automations.removed.length} deleted`,
      ]
        .filter(Boolean)
        .join(', ') || 'nothing changed'}`,
      detail: applied,
    });
    this.#deps.bus?.publish({ kind: 'changed', deviceId: null });
    for (const key of [...applied.automations.added, ...applied.automations.changed]) {
      const automation = this.#deps.automations.byKey(key);
      if (automation) this.#deps.bus?.publish({ kind: 'automation', automationId: automation.id });
    }
    return applied;
  }

  /** Restores the copy kept beside the database: `text`, read by the place, which copied it aside to `from` first. */
  restore(text: string, from: string): Promise<Restored> {
    return restoreFrom(this.#deps, text, from);
  }

  /**
   * The whole configuration as the copy kept beside the database holds it:
   * every secret sealed with this home's key. `before`: the copy as it is
   * now, whose seals are kept while they still open to the same value, so a
   * home that has not changed is not written again for a fresh seal.
   */
  async kept(before: string | null): Promise<string> {
    const keptBefore = before ? (readConfig(before).document?.secrets ?? {}) : {};
    const { document, context } = await exportConfig(this.#deps, { secrets: 'kept', keptBefore });
    return writeConfig(document, { ...context, heading: KEPT_HEADING });
  }

  /** Forgets every plan made and not applied, with the secrets each opened: the home is stopping. */
  stop(): void {
    this.#deps.pending.stop();
  }
}
