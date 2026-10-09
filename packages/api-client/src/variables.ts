import type { VariableView } from '@kraftverk/api-contract';

/*
  A home's variables in words (docs/PLAN-VARIABLES-AND-TRIGGERS.md): who
  set one last, and when — what the home screen says beneath each.
*/

const time = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** A timer's time left now, in ms: running, to its end; paused, what was left; else none. */
export function timerLeft(variable: Pick<VariableView, 'value' | 'endsAt' | 'leftMs'>, now: number): number | null {
  if (variable.value === 'running' && variable.endsAt) return Math.max(0, Date.parse(variable.endsAt) - now);
  if (variable.value === 'paused') return variable.leftMs;
  return null;
}

/** Time left, as a clock counts down: "4:05", "1:02:03". */
export function countdownText(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Who set it last, and when — or, nobody has, that it is as it starts. */
export function variableLine(variable: Pick<VariableView, 'setAt' | 'by'>): string {
  return variable.setAt ? `Set ${time(variable.setAt)}${variable.by ? ` by ${variable.by}` : ''}` : 'As it starts';
}
