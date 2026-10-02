import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { Caller, KraftverkApi } from '@kraftverk/api-contract';
import type { Hub } from '@kraftverk/hub';

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
  config: ServerConfig;
  proxies: ProxyDirectory;
  serverLog: Pick<ServerLog, 'dir' | 'recent'>;
  startedAt: Date;
  /** Login guessing; a fresh one unless a test wants to share it. */
  limiter?: LoginLimiter;
  /** The configuration kept beside the database, as a file; none in a test that does not ask for one. */
  snapshot?: ConfigSnapshot;
};

/** Who a request is, to the home: the person signed in on it. */
export const callerOf = (c: Context): Caller => {
  const account = userOf(c)?.id;
  return { kind: 'person', name: actorOf(c), ...(account ? { account } : {}) };
};

/** The home, as the person a request is from asks it. */
export const homeFor = (deps: Pick<AppDeps, 'hub'>, c: Context): KraftverkApi => deps.hub.as(callerOf(c));

/**
 * Parses and validates a JSON body.
 *
 * Deliberately not @hono/zod-validator: that package hoists to the workspace
 * root where it binds to the zod v3 an Expo dependency pulls in, while this
 * package is on zod v4. Validating inline keeps one zod and full type inference.
 */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Expected a JSON body' });
  });
  return schema.parse(raw);
}
