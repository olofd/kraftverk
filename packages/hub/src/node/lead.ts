import type { NodeTraits } from '@kraftverk/device-sdk';

/*
  Which node is the home's master (docs/ARCHITECTURE.md, decision 24): chosen
  by what each node declares it is, never by which kind of machine it is.
  The master keeps the home — its devices, history and automations — so the
  fittest is one that runs while nobody looks, and that the others can reach:
  a machine on the network, when there is one; a phone, when it is alone.
  The role moves by a hand-over a person sees (`move.ts`, `keep.ts`), and
  only to a node that fits it better: never two writers, and never a change
  for nothing.
*/

/** How fit a node is to be the master: always on first, then reached by others. */
export const masterFitness = (node: NodeTraits): number => (node.alwaysOn ? 2 : 0) + (node.reachable ? 1 : 0);

/** Whether a node should take the master's role from the one that has it: only one that fits it better. */
export const shouldLead = (candidate: NodeTraits, master: NodeTraits): boolean => masterFitness(candidate) > masterFitness(master);
