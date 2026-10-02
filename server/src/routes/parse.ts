import type { Context } from 'hono';
import type { z } from 'zod';

import { ApiError } from '@kraftverk/api-contract';

/*
  What a request says, checked: a JSON body or a query string against its
  shape. One way for every route — the home's, a sign-in — so a request that
  does not hold is refused in one shape the app reads: the home's refusal.

  Deliberately not @hono/zod-validator: that package hoists to the workspace
  root where it binds to the zod v3 an Expo dependency pulls in, while this
  package is on zod v4. Validating inline keeps one zod and full type
  inference.
*/

/** A request that does not hold, as the home's refusal: its first problem in words the app shows as they are, and each of them. */
export function invalid(error: z.ZodError): ApiError {
  const said = error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
  return new ApiError('invalid', error.issues[0]?.message ?? 'That request does not hold', { problems: said });
}

/** A JSON body, parsed and checked. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw: unknown = await c.req.json().catch(() => {
    throw new ApiError('invalid', 'Expected a JSON body');
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

/** A query string, checked as a body is. */
export function query<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}
