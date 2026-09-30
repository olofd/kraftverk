import { useEffect, useState } from 'react';
import { useTheme } from 'tamagui';

import type { AutomationRun, RunStep, StepKind } from '@kraftverk/api-client';
import type { IconName } from '@kraftverk/ui';

/**
 * How automations and their runs look (docs/SEQUENCES.md): each outcome its
 * own icon and colour, each kind of step its own icon, and time said the way a
 * person reads it. One place, so a card, a device's page and a timeline agree.
 */

export type Tone = '$success' | '$warning' | '$accent' | '$muted' | '$danger' | '$color' | '$background';
export type Look = { icon: IconName; tone: Tone };

/** A run, by what it came to. */
export const OUTCOME: Record<AutomationRun['outcome'], Look & { label: string }> = {
  acted: { icon: 'check', tone: '$success', label: 'Done' },
  unverified: { icon: 'alert-triangle', tone: '$warning', label: 'Not confirmed' },
  'would-act': { icon: 'eye', tone: '$accent', label: 'Would' },
  idle: { icon: 'minus', tone: '$muted', label: 'Nothing to do' },
  unknown: { icon: 'help-circle', tone: '$warning', label: 'Could not tell' },
  refused: { icon: 'slash', tone: '$warning', label: 'Refused' },
  failed: { icon: 'x', tone: '$danger', label: 'Did not succeed' },
  running: { icon: 'loader', tone: '$accent', label: 'Running' },
  stopped: { icon: 'square', tone: '$muted', label: 'Stopped' },
  interrupted: { icon: 'alert-octagon', tone: '$warning', label: 'Interrupted' },
};

/** One step of a run, by how it went. */
export const STEP: Record<RunStep['outcome'], Look & { label: string }> = {
  done: { icon: 'check', tone: '$success', label: 'Done' },
  already: { icon: 'check', tone: '$muted', label: 'Already so' },
  unverified: { icon: 'alert-triangle', tone: '$warning', label: 'Not confirmed' },
  refused: { icon: 'slash', tone: '$warning', label: 'Refused' },
  failed: { icon: 'x', tone: '$danger', label: 'Failed' },
  would: { icon: 'eye', tone: '$accent', label: 'Would' },
  waiting: { icon: 'loader', tone: '$accent', label: 'Now' },
  met: { icon: 'check', tone: '$success', label: 'Yes' },
  'not-met': { icon: 'corner-down-right', tone: '$muted', label: 'No' },
  'timed-out': { icon: 'clock', tone: '$danger', label: 'Not in time' },
  stopped: { icon: 'square', tone: '$muted', label: 'Stopped' },
};

/** Each kind of step, its own mark: what a sequence is made of, seen at a glance. */
export const KIND: Record<StepKind, IconName> = {
  command: 'power',
  wait: 'pause',
  waitUntil: 'clock',
  ensure: 'repeat',
  choose: 'git-branch',
  watch: 'eye',
  write: 'sliders',
  start: 'play-circle',
};

/** A theme colour by its token, for what takes a colour rather than a token: an icon. */
export function useTone(): (tone: Tone) => string | undefined {
  const theme = useTheme();
  return (tone) => (theme[tone.slice(1) as keyof typeof theme] as { val?: string } | undefined)?.val;
}

/** The time now, moving every second while `on`: what a countdown reads. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** "14:02". */
export const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Today", "Yesterday", "12 Sep". */
export function dayOf(at: string): string {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "Just now", "12 min ago", "Today 14:02", "12 Sep 07:00". */
export function ago(at: string): string {
  const seconds = (Date.now() - Date.parse(at)) / 1000;
  if (seconds < 45) return 'Just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  return `${dayOf(at)} ${clock(at)}`;
}

/** A span of seconds as a stopwatch reads it: "0:07", "1:42", "1:02:05". */
export function stopwatch(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** How long a step took, or has taken so far: "4 s", "1 min 12 s". */
export function took(from: string, to: string | number): string {
  const seconds = Math.max(0, Math.round(((typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
}

/** " · took 1 min 12 s" for a run that took a second or more; nothing for one that was over at once. */
export const lasted = (run: Pick<AutomationRun, 'at' | 'endedAt'>): string =>
  run.endedAt && Date.parse(run.endedAt) - Date.parse(run.at) >= 1000 ? ` · took ${took(run.at, run.endedAt)}` : '';
