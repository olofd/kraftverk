import type { Caller } from '@kraftverk/api-contract';

/** Who a caller is on the timeline: a person by their name, an assistant as acting for one. */
export const actorOf = (caller: Caller): string => (caller.kind === 'person' ? caller.name : `assistant for ${caller.for}`);

/** Who a caller is to the gateway: a person, whose yes it binds a confirmation to, or an agent, refused what needs one. */
export const intentOf = (caller: Caller): { actor: 'user' | 'agent'; by: string } => ({ actor: caller.kind === 'person' ? 'user' : 'agent', by: actorOf(caller) });
