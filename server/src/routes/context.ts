import type { Context } from 'hono';
import { z } from 'zod';

import type { Caller, KraftverkApi, RoleBinding } from '@kraftverk/api-contract';
import { NODE_ID, RESOURCE_KINDS, savedDeviceId, type ResourceKind } from '@kraftverk/device-sdk';
import type { Hub } from '@kraftverk/hub';

import type { Accounts } from '../auth/accounts.ts';
import { actorOf, userOf } from '../auth/routes.ts';
import type { LoginLimiter } from '../auth/limiter.ts';
import type { ProxyDirectory } from '../auth/trust.ts';
import type { ServerConfig } from '../config.ts';
import type { ServerLog } from '../log.ts';
import type { ConfigSnapshot } from '../platform/snapshot.ts';

/**
 * Everything the routes need, handed in rather than reached for: the home
 * they adapt HTTP to, and what is the server's own.
 *
 * The server builds a hub at startup and a test one around simulators and a
 * throwaway database; the routes cannot tell the difference, which is the
 * point.
 */
export type AppDeps = {
  /** The home: what the routes adapt from HTTP to (`hub.as(caller)`). */
  hub: Hub;
  /** Who may sign in to this entrance, and their sessions. */
  accounts: Accounts;
  config: ServerConfig;
  proxies: ProxyDirectory;
  serverLog: Pick<ServerLog, 'dir' | 'recent'>;
  startedAt: Date;
  /** Login guessing; a fresh one unless a test wants to share it. */
  limiter?: LoginLimiter;
  /** The configuration kept beside the database, as a file; none in a test that does not ask for one. */
  snapshot?: ConfigSnapshot;
};

/** The home, as the person a request is from asks it. */
export const homeFor = (deps: Pick<AppDeps, 'hub'>, c: Context): KraftverkApi => {
  const account = userOf(c)?.id;
  const caller: Caller = { kind: 'person', name: actorOf(c), ...(account ? { account } : {}) };
  return deps.hub.as(caller);
};

// --- shapes more than one route takes ------------------------------------------

/** A part of a device: a role's filling, a link's end. */
export const PART = z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict();

/** What each role is filled by, its devices' ids as ids. */
export const bindingsOf = (given: Record<string, z.infer<typeof PART>>): Record<string, RoleBinding> =>
  Object.fromEntries(Object.entries(given).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }]));

/** What the timeline's entries are about. */
export const RESOURCE_KIND = z.enum(RESOURCE_KINDS as [ResourceKind, ...ResourceKind[]]);

/** The node a follower speaks for, and a connection it holds. */
export const HELD_BY = { nodeId: z.string().regex(NODE_ID), connectionId: z.string().min(1).max(40) };
