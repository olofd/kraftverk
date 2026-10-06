import type { DeviceTypeList, DeviceTypeListing } from '@kraftverk/api-contract';
import { NODE_TRAITS, PLATFORMS, type IntegrationInfo, type NodeTraits, type Platform, type Reach, type Updates } from '@kraftverk/device-sdk';

/*
  What a home has installed, by platform (docs/PLAN-INTEGRATIONS.md §1):
  each integration with the products on it and its own types, and where
  they run (§0) — read from the home's list of types, which names each
  one's platform.
*/

/** One installed integration, as the Integrations page shows it. */
export type InstalledPlatform = {
  integration: IntegrationInfo;
  /** The products on it, from device packages. */
  products: DeviceTypeListing[];
  /** Its own: a service, a gateway, an account, the generic type a product nobody described falls back to. */
  own: DeviceTypeListing[];
};

/** Each installed integration, in the order the home lists them, with its products and its own types in the order they are offered. */
export function byPlatform(list: Pick<DeviceTypeList, 'integrations' | 'types'>): InstalledPlatform[] {
  return list.integrations.map((integration) => {
    const on = list.types.filter((type) => type.source.integration.id === integration.id);
    return { integration, products: on.filter((type) => type.source.product), own: on.filter((type) => !type.source.product) };
  });
}

/** What a node must be to hold some way of these: one trait, with every reason given for it. */
export type Need = { trait: keyof NodeTraits; why: string[] };

/**
 * Where some types run, together — the two facts kept apart: every platform
 * one of their ways can be held on, and what the node holding such a way
 * must be, each reason once.
 */
export function whereTheyRun(types: readonly Pick<DeviceTypeListing, 'placements'>[]): { platforms: Platform[]; needs: Need[] } {
  const placements = types.flatMap((type) => type.placements);
  const platforms = PLATFORMS.filter((platform) => placements.some((placement) => placement.platforms.includes(platform)));
  const needs = NODE_TRAITS.flatMap((trait) => {
    const why = [...new Set(placements.flatMap((placement) => (placement.needs[trait] === undefined ? [] : [placement.needs[trait]!])))];
    return why.length ? [{ trait, why }] : [];
  });
  return { platforms, needs };
}

/** Where a node runs, as a person says it. */
const ON: Record<Platform, string> = { system: 'on a server', web: 'in a browser', native: 'on a phone' };

/** What a node must be, as a person says it. */
const MUST_BE: Record<Need['trait'], string> = { alwaysOn: 'always on', reachable: 'reachable by your other nodes', trusted: 'trusted to keep it' };

/** "a", "a and b", "a, b and c". */
const listed = (words: readonly string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** Where some types run, said in two sentences kept apart: the platforms, then what the node holding them must be, and why. */
export function whereTheyRunSaid(types: readonly Pick<DeviceTypeListing, 'placements'>[]): string {
  const { platforms, needs } = whereTheyRun(types);
  if (!platforms.length) return 'Nothing installed on it yet';
  const where = `Runs ${listed(platforms.map((platform) => ON[platform]))}.`;
  const must = needs.map((need) => `Held by a node that is ${MUST_BE[need.trait]}: ${need.why.join('; ')}.`);
  return [where, ...must].join(' ');
}

/** How far a way reaches, and how what it says arrives, as a person says them: what the add screen shows beside each way. */
export function waySaid(method: { readonly reach: Reach; readonly updates: Updates }): string {
  const reach = method.reach === 'local' ? 'On your home network, no cloud' : method.reach === 'cloud-at-setup' ? 'Your home network, after the cloud once at setup' : 'Over the internet, through its maker’s cloud';
  const updates = method.updates === 'push' ? 'it tells as it happens' : method.updates === 'poll' ? 'asked every so often' : 'asked, and it tells what changes between';
  return reach + ' · ' + updates;
}
