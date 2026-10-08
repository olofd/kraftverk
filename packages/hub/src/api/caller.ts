import type { Caller } from '@kraftverk/api-contract';
import { actor } from '@kraftverk/device-sdk';
import type { GatewayActor } from '@kraftverk/gateway';

/**
 * Who a caller is, on the timeline and to the gateway: a person, whose yes a
 * confirmation is bound to, or an assistant acting for one, refused what
 * needs a yes. A person by their id, where they have one.
 */
export const actorOf = (caller: Caller): GatewayActor & { kind: 'person' | 'agent' } =>
  caller.kind === 'person' ? { ...actor('person', caller.name, caller.id ?? null), kind: 'person' } : { ...actor('agent', `assistant for ${caller.for}`), kind: 'agent' };

/** What a caller's intent to the gateway carries: who asks. */
export const intentOf = (caller: Caller): { by: GatewayActor & { kind: 'person' | 'agent' } } => ({ by: actorOf(caller) });
