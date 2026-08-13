import { ACTUATOR_CONFIRMATION, type GridRelayProvider, type RelayState } from '@kraftverk/plugin-sdk';

import { audit, type AuditEntry } from '../history/db.ts';
import type { StationStatus } from '../types.ts';

/**
 * The only thing in this codebase allowed to switch mains.
 *
 * Everything a relay command has to survive lives here: the grant, the policy,
 * the freshness of the data the decision rests on, and — the part that makes it
 * more than a wrapper — verification in two stages. The plug saying "done" is
 * not proof; the station's own AC input agreeing is.
 *
 * Design and rationale: docs/PLUGIN-ARCHITECTURE.md §5.
 */

export const CONFIRMATION_PHRASE = ACTUATOR_CONFIRMATION;

export type RelayIntent = {
  desired: boolean;
  reason: string;
  actor: 'user' | 'controller';
  /** Required when cutting mains, and for the first switch of a new plug. */
  confirmation?: string;
};

export type GatewayOutcome =
  | 'verified'      // relay moved and the station agrees
  | 'unverified'    // command accepted, but the physical effect is unproven
  | 'refused'       // policy said no; nothing was sent
  | 'failed';       // the command itself errored

export type GatewayResult = {
  outcome: GatewayOutcome;
  detail: string;
  relayReported?: boolean;
  stationAgreed?: boolean;
  state?: RelayState;
};

export type GatewayPolicy = {
  /** How old station telemetry or relay state may be and still be acted on. */
  maxDataAgeMs: number;
  /** Minimum gap between controller-driven changes. */
  controllerDwellMs: number;
  /** A much shorter guard for a person tapping a button, so the acceptance drill is possible. */
  userDwellMs: number;
  /** How long the station is given to agree that AC came or went. */
  verifyTimeoutMs: number;
};

export const DEFAULT_POLICY: GatewayPolicy = {
  maxDataAgeMs: 60_000,
  controllerDwellMs: 10 * 60_000,
  userDwellMs: 5_000,
  verifyTimeoutMs: 30_000,
};

/**
 * Only the part of the plugin host this needs.
 *
 * Narrow on purpose: the gateway has no business reading configuration or
 * starting plugins, and the narrower dependency is what lets it be tested
 * against a stub with no database and no plugins loaded.
 */
export type RelayHost = {
  activeProvider(resource: 'gridRelay'): string | null;
  capability(id: string, name: 'gridRelay.read'): GridRelayProvider | null;
  isGranted(id: string, capability: 'gridRelay.switch'): boolean;
};

export type GatewayDeps = {
  host: RelayHost;
  /** Current station telemetry, or null when nothing is connected. */
  readStation: () => StationStatus | null;
  /** True when the server refuses every hardware write. */
  isReadOnly: () => boolean;
  /** Where the timeline goes. Swapped out in tests so they touch no database. */
  record?: (entry: AuditEntry) => void;
  policy?: Partial<GatewayPolicy>;
};

export class ActionGateway {
  #deps: GatewayDeps;
  #policy: GatewayPolicy;
  #record: (entry: AuditEntry) => void;
  #lastSwitchAt = 0;
  #everSwitched = false;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#policy = { ...DEFAULT_POLICY, ...deps.policy };
    this.#record = deps.record ?? audit;
  }

  /** The provider that currently owns the relay, if it is running and granted. */
  provider(): { id: string; impl: GridRelayProvider } | null {
    const id = this.#deps.host.activeProvider('gridRelay');
    if (!id) return null;
    const impl = this.#deps.host.capability(id, 'gridRelay.read');
    return impl ? { id, impl } : null;
  }

  async state(): Promise<(RelayState & { provider: string }) | null> {
    const provider = this.provider();
    if (!provider) return null;
    try {
      return { ...(await provider.impl.getState()), provider: provider.id };
    } catch {
      return null;
    }
  }

  async execute(intent: RelayIntent): Promise<GatewayResult> {
    const at = new Date().toISOString();
    const refuse = (detail: string): GatewayResult => {
      this.#record({ at, kind: 'relay.refused', actor: intent.actor, resource: 'gridRelay', summary: detail, detail: intent });
      return { outcome: 'refused', detail };
    };

    // 1. A provider that is actually running.
    const provider = this.provider();
    if (!provider) return refuse('No healthy grid-relay plugin owns the relay');

    // 2. The grant. Configuring a plugin is not the same as permitting it to act.
    if (!this.#deps.host.isGranted(provider.id, 'gridRelay.switch')) {
      return refuse(`${provider.id} has not been granted permission to switch the relay`);
    }

    // 3. Policy, evaluated now rather than when the plugin was configured.
    if (this.#deps.isReadOnly()) return refuse('The server is in read-only mode');

    const dwell = intent.actor === 'controller' ? this.#policy.controllerDwellMs : this.#policy.userDwellMs;
    const sinceLast = Date.now() - this.#lastSwitchAt;
    if (this.#lastSwitchAt > 0 && sinceLast < dwell) {
      return refuse(`Too soon: ${Math.ceil((dwell - sinceLast) / 1000)}s of the dwell time remains`);
    }

    // Cutting mains, and the first switch of any plug, need a deliberate act.
    const needsConfirmation = intent.actor === 'user' && (!intent.desired || !this.#everSwitched);
    if (needsConfirmation && intent.confirmation !== CONFIRMATION_PHRASE) {
      return refuse('This action needs explicit confirmation');
    }

    // 4. Freshness. Acting on stale readings is how a controller cuts mains at
    //    exactly the wrong moment.
    const station = this.#deps.readStation();
    const relayBefore = await provider.impl.getState().catch(() => null);

    if (!relayBefore || !relayBefore.reachable) return refuse('The plug is not answering');
    if (this.#ageOf(relayBefore.updatedAt) > this.#policy.maxDataAgeMs) {
      return refuse('The plug state is stale');
    }
    if (!station) return refuse('No station telemetry: refusing to switch blind');
    if (this.#ageOf(station.lastUpdated) > this.#policy.maxDataAgeMs) {
      return refuse('Station telemetry is stale: refusing to switch blind');
    }

    if (relayBefore.relayOn === intent.desired) {
      return { outcome: 'verified', detail: 'Already in the requested state', state: relayBefore, relayReported: true, stationAgreed: true };
    }

    // 5. Record the intent before anything physical happens.
    this.#record({
      at,
      kind: 'relay.intent',
      actor: intent.actor,
      resource: 'gridRelay',
      summary: `Requested grid AC ${intent.desired ? 'on' : 'off'}: ${intent.reason}`,
      detail: { provider: provider.id, before: relayBefore, stationAc: station.gridConnected },
    });

    // 6. Exactly one command.
    this.#lastSwitchAt = Date.now();
    this.#everSwitched = true;
    const result = await provider.impl.setRelay(intent.desired, intent.reason);

    if (!result.accepted) {
      this.#record({
        at: new Date().toISOString(),
        kind: 'relay.failed',
        actor: intent.actor,
        resource: 'gridRelay',
        summary: `Command rejected: ${result.error ?? 'unknown error'}`,
      });
      return { outcome: 'failed', detail: result.error ?? 'The plug rejected the command' };
    }

    // 7. Two separate proofs, recorded separately.
    const after = result.readback ?? (await provider.impl.getState().catch(() => null));
    const relayReported = after?.relayOn === intent.desired;
    const stationAgreed = await this.#stationAgrees(intent.desired);

    const outcome: GatewayOutcome = relayReported && stationAgreed ? 'verified' : 'unverified';
    const detail = relayReported
      ? stationAgreed
        ? `Grid AC ${intent.desired ? 'restored' : 'removed'}, confirmed by the plug and the station`
        : `The plug says ${intent.desired ? 'on' : 'off'} but the station's AC input has not agreed`
      : 'The plug accepted the command but does not report the new state';

    // 8. The outcome, with both pieces of evidence.
    this.#record({
      at: new Date().toISOString(),
      kind: `relay.${outcome}`,
      actor: intent.actor,
      resource: 'gridRelay',
      summary: detail,
      detail: { relayReported, stationAgreed, after },
    });

    return { outcome, detail, relayReported, stationAgreed, state: after ?? undefined };
  }

  /**
   * Waits for the station's own telemetry to confirm mains arrived or left.
   *
   * This is the half that catches a relay which reports success and does
   * nothing, and — when restoring — the difference between a working relay and
   * an actual grid outage.
   */
  async #stationAgrees(desired: boolean): Promise<boolean> {
    const deadline = Date.now() + this.#policy.verifyTimeoutMs;
    while (Date.now() < deadline) {
      const station = this.#deps.readStation();
      if (station && station.gridConnected === desired) return true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  #ageOf(iso: string): number {
    const at = new Date(iso).getTime();
    return Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY;
  }
}
