import type { ReactNode } from 'react';

import { MapApiProvider } from '@kraftverk/ui';

import { useServers } from './ServersProvider';

/**
 * Where every map in the app is drawn from: the server's own tiles, under
 * its API (docs/PLAN-MAPS.md). With no server, none — a map says so.
 */
export function ServerMap({ children }: { children: ReactNode }) {
  const { active } = useServers();
  return <MapApiProvider value={active?.url ?? null}>{children}</MapApiProvider>;
}
