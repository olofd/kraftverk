import { isSimulated, unmetNeed, type ConnectionMethod, type NodeTraits } from '@kraftverk/device-sdk';

/** What a node must be, in a reason a person reads: what the people of a home have, said by what it is. */
const NEEDED: Record<keyof NodeTraits, string> = {
  trusted: 'a node trusted with it, such as your server',
  alwaysOn: 'a node that is always on, such as your server',
  reachable: 'a node others can reach, such as your server',
};

/**
 * Why a node cannot hold a method, from what the method needs of the node
 * holding it (`needs`): "It needs a node trusted with it, such as your
 * server: your account password stays at home". Null when it can. A simulated
 * way reaches nothing, and needs nothing.
 */
export function unfitFor(method: Pick<ConnectionMethod, 'needs'> & { readonly transport?: string }, node: NodeTraits): string | null {
  if (isSimulated(method)) return null;
  const unmet = unmetNeed(method, node);
  return unmet ? `It needs ${NEEDED[unmet.trait]}: ${unmet.why}` : null;
}
