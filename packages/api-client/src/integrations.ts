import type { DeviceTypeList, DeviceTypeListing } from '@kraftverk/api-contract';
import { NODE_TRAITS, PLATFORMS, type IntegrationInfo, type NodeTraits, type Platform } from '@kraftverk/device-sdk';

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
