import type { Caller } from '@kraftverk/api-contract';
import { actor } from '@kraftverk/device-sdk';
import type { GatewayActor } from '@kraftverk/gateway';

/**
 * Who a caller is, on the timeline and to the gateway: a person, whose yes a
 * confirmation is bound to; an assistant acting for one, refused what needs
 * a yes; or an automation's script, as the automation. A person by their id,
 * where they have one.
 */
export const actorOf = (caller: Caller): GatewayActor =>
  caller.kind === 'person'
    ? { ...actor('person', caller.name, caller.id ?? null), kind: 'person' }
    : caller.kind === 'agent'
      ? { ...actor('agent', `assistant for ${caller.for}`), kind: 'agent' }
      : { ...actor('automation', caller.name, caller.id), kind: 'automation' };

/** How often a script's run may switch one part, at most: as a few command steps would. */
const SCRIPT_SWITCHES = 4;

/**
 * What a caller's intent to the gateway carries: who asks — and, for a
 * script, the run it is a step of, so the gateway counts its switches as a
 * step's and lets them go when the run ends.
 */
export const intentOf = (caller: Caller): { by: GatewayActor; run?: { id: string; askedBy: 'person' | 'agent' | null; switches: number } } =>
  caller.kind === 'automation' ? { by: actorOf(caller), run: { ...caller.run, switches: SCRIPT_SWITCHES } } : { by: actorOf(caller) };
