import { useEffect, useState } from 'react';

import { SetupFlow, type HeldBy, type KraftverkApi } from '@kraftverk/api-client';

/*
  The setups in progress in this app, by their draft's id: one flow shared by
  the pages of its steps (`/setup/<draft>/<step>`), each its own address. A
  page that finds none — opened again after a reload — takes the draft up
  again from the home. One that no step page shows any more is discarded, so
  a secret it holds does not outlive the flow; one saved is let go.
*/

type Live = { flow: SetupFlow; named: string | null; showing: number; leaving: ReturnType<typeof setTimeout> | null };

const live = new Map<string, Live>();

/** How long a draft stays when no step shows it: long enough for one step's page to give way to the next. */
const LEFT_AFTER_MS = 1_500;

/** A flow just started, before its first step's page opens. */
export function keepFlow(flow: SetupFlow): void {
  live.set(flow.id, { flow, named: null, showing: 0, leaving: null });
}

/** Saved: let go of it, with nothing to discard. */
export function doneWith(draftId: string): void {
  const kept = live.get(draftId);
  if (kept?.leaving) clearTimeout(kept.leaving);
  live.delete(draftId);
}

/** Given up: the draft is discarded now. */
export function dropFlow(draftId: string): void {
  live.get(draftId)?.flow.discard();
  doneWith(draftId);
}

/** What a helper learnt the device is called — its name in its maker's app — offered when it is named. */
export const namedIn = (draftId: string): string | null => live.get(draftId)?.named ?? null;
export function nameFound(draftId: string, name: string | null): void {
  const kept = live.get(draftId);
  if (kept) kept.named = name;
}

/** The flow a step's page shows: kept, or taken up again from the home. */
export function useFlow(api: KraftverkApi, draftId: string, holder: HeldBy): { flow: SetupFlow | null; error: string | null } {
  const [flow, setFlow] = useState<SetupFlow | null>(live.get(draftId)?.flow ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    const kept = live.get(draftId);
    if (kept) {
      if (kept.leaving) clearTimeout(kept.leaving);
      kept.leaving = null;
      kept.showing += 1;
      setFlow(kept.flow);
    } else {
      SetupFlow.resume(api, draftId, holder)
        .then((resumed) => {
          if (gone) return;
          live.set(draftId, { flow: resumed, named: null, showing: 1, leaving: null });
          setFlow(resumed);
        })
        .catch(() => !gone && setError('This setup is no longer here: it ended, or was left too long. Start it again.'));
    }
    return () => {
      gone = true;
      const shown = live.get(draftId);
      if (!shown) return;
      shown.showing = Math.max(0, shown.showing - 1);
      if (shown.showing === 0) shown.leaving = setTimeout(() => dropFlow(draftId), LEFT_AFTER_MS);
    };
  }, [api, draftId, holder]);

  return { flow, error };
}
