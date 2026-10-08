import { useState } from 'react';

import type { AutomationId } from '@kraftverk/device-sdk';
import { describeError, type AutomationView } from '@kraftverk/api-client';
import { triggerAsNext } from '@kraftverk/automation';

import { useFamily } from '../../state/FamilyProvider';
import { haptic } from '@kraftverk/ui';

import { confirmAction } from '../../platform/confirm';
import { ago, OUTCOME, stopwatch, useNow } from './looks';

/**
 * Running an automation now, and stopping it while it runs
 * (docs/AUTOMATION-EDITOR.md) — from its card in a list or on the home page,
 * and from its own page.
 *
 * Start runs it now, for real, whatever it does on its own: its steps each
 * go through the gateway, as a tap on a switch does. One that only watches
 * on its own asks first, every time — it has not been let act, and this
 * acts. While it runs, Stop ends the step it is in and runs what it does if
 * stopped. Off, it cannot be started, and says so.
 */
export function useRun(automation: AutomationView, onChanged: (next: AutomationView) => void) {
  const { api } = useFamily();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const running = automation.running;
  const now = useNow(running !== null);
  // The step it is in: the last still going, else the last taken.
  const current = running ? ([...running.steps].reverse().find((step) => step.outcome === 'waiting') ?? running.steps[running.steps.length - 1] ?? null) : null;

  const act = async (work: () => Promise<void>) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(async () => {
      // Only watching on its own: started by a person, it acts — said, and asked, first.
      if (automation.mode === 'watch') {
        const yes = await confirmAction(`Start “${automation.name}” now?`, `It only watches on its own, but started by you it acts, for real:\n\n${automation.sentence}`, 'Start it');
        if (!yes) return;
      }
      onChanged(await api.automations.start(automation.id as AutomationId));
    });
  const stop = () => act(async () => onChanged(await api.automations.stop(automation.id as AutomationId)));

  /** Why it cannot be started now, when it cannot: off, or something it needs is gone. */
  const blocked = automation.mode === 'off' ? 'It is off' : automation.problems.length ? `It cannot run as it is: ${automation.problems[0]}` : null;

  return { busy, problem, running, blocked, start, stop, status: statusOf(automation, now, current?.what ?? null) };
}

/**
 * One line of how it stands, as its card and its page say it: running and the
 * step it is in; off; what stops it running; what it did last; or what starts
 * it next.
 */
function statusOf(automation: AutomationView, now: number, step: string | null): string {
  const running = automation.running;
  if (running) return `Running · ${stopwatch((now - Date.parse(running.at)) / 1000)}${step ? ` · ${step}` : ''}`;
  if (automation.mode === 'off') return 'Off';
  if (automation.problems.length) return `Cannot run: ${automation.problems[0]}`;
  const last = automation.lastRun;
  // A summary says what came of it — "Turned Laddare off", "Did not succeed: …" — except where only the outcome can.
  if (last) return `${SAID_BY_OUTCOME.has(last.outcome) ? `${OUTCOME[last.outcome].label}: ` : ''}${last.summary} · ${ago(last.endedAt ?? last.at)}`;
  return automation.when[0] ? triggerAsNext(automation.when[0]) : 'Not started yet';
}

/** The outcomes a run's summary does not say by itself: refused, done but not confirmed, could not tell. */
const SAID_BY_OUTCOME = new Set(['refused', 'unverified', 'unknown']);
