import type { AcInputCapability, CapabilityName, CommandResult, OutletsCapability, PowerMeterCapability, SwitchCapability } from './capabilities.ts';
import type { DeviceSession } from './device-type.ts';
import type { LinkKind } from './links.ts';

/**
 * How each command in the capability library reaches a device, and how its
 * effect is read back (docs/ARCHITECTURE.md §4.6, step 18).
 *
 * The gateway applies the same rules to every command — read-only, dwell,
 * freshness, confirmation, verification — and asks this table how to read and
 * send one, so it names no capability itself: a new actuating capability is
 * one reviewed entry here, not an edit to the gateway.
 */

/** A switchable part's state, as a command's checks need it. Null fields are unknown, never off. */
export type PartState = { on: boolean | null; at: string | null; watts: number | null };

export type Actuator = {
  /** Whether the command names a part — an outlet — or the whole device. */
  targeted: boolean;
  /** The part's state now, from what the session holds. Null when the session cannot do this. */
  read(session: DeviceSession, target: string | undefined): PartState | null;
  send(session: DeviceSession, target: string | undefined, value: boolean): Promise<CommandResult>;
};

export const ACTUATORS: { readonly [N in CapabilityName]?: Readonly<Record<string, Actuator>> } = {
  switch: {
    set: {
      targeted: false,
      read(session) {
        const impl = session.capability('switch') as SwitchCapability | null;
        if (!impl) return null;
        const state = impl.state();
        const meter = (session.capability('powerMeter') as PowerMeterCapability | null)?.read() ?? null;
        return { on: state?.on ?? null, at: state?.at ?? null, watts: meter?.watts ?? null };
      },
      send: (session, _target, value) => (session.capability('switch') as SwitchCapability).set(value),
    },
  },
  outlets: {
    set: {
      targeted: true,
      read(session, target) {
        const impl = session.capability('outlets') as OutletsCapability | null;
        if (!impl || !target) return null;
        const reading = impl.read();
        const outlet = reading?.outlets.find((candidate) => candidate.id === target);
        // An outlet the device does not have is not an outlet that is off.
        if (reading && !outlet) return null;
        return { on: outlet?.on ?? null, at: reading?.at ?? null, watts: outlet?.watts ?? null };
      },
      send: (session, target, value) => (session.capability('outlets') as OutletsCapability).set(target!, value),
    },
  },
};

/** The actuator for a capability's command, or null when it has none. */
export const actuatorOf = (capability: CapabilityName, command: string): Actuator | null => ACTUATORS[capability]?.[command] ?? null;

/** What a link's target says, as the second proof that switching its source did something. */
export type LinkEvidence = { connected: boolean; present: boolean | null; at: string | null };

/**
 * For each link kind, what its target reads that the source's switching should
 * change: a station that a plug `feeds` sees its mains come and go.
 */
export const LINK_EVIDENCE: Readonly<Record<LinkKind, (session: DeviceSession) => LinkEvidence | null>> = {
  feeds(session) {
    const acInput = session.capability('acInput') as AcInputCapability | null;
    if (!acInput) return null;
    const reading = acInput.read();
    return { connected: session.health().status === 'connected', present: reading?.present ?? null, at: reading?.at ?? null };
  },
};
