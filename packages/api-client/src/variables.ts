import type { VariableView } from '@kraftverk/api-contract';

/*
  A home's variables in words (docs/PLAN-VARIABLES-AND-TRIGGERS.md): who
  set one last, and when — what the home screen says beneath each.
*/

const time = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Who set it last, and when — or, nobody has, that it is as it starts. */
export function variableLine(variable: Pick<VariableView, 'setAt' | 'by'>): string {
  return variable.setAt ? `Set ${time(variable.setAt)}${variable.by ? ` by ${variable.by}` : ''}` : 'As it starts';
}
