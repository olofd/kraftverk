import type { IntegrationUi } from '@kraftverk/api-client';

import { INTEGRATION_UI } from '../../generated/registry';

export type { IntegrationUi };

/**
 * Which pieces of its pages an integration draws itself: found, not listed —
 * `src/generated/registry.ts` is written by `npm run gen:devices` from every
 * installed integration that ships screens (`kraftverk.integration.ui`). One
 * with none gets the app's pages alone, which say everything an integration
 * has to; its own pieces add what only it knows.
 */
export const integrationScreens = (id: string | null | undefined): IntegrationUi | null => (id ? (INTEGRATION_UI[id] ?? null) : null);
