import { RUN_FACTS } from '../rule.ts';
import { EXPR_KIND_ORDER } from './exprs.ts';
import type { FieldSpec } from './spec.ts';
import { STEP_KIND_ORDER, STEP_KINDS } from './steps.ts';
import { TRIGGER_KIND_ORDER, TRIGGER_KINDS } from './triggers.ts';

/*
  The shape a rule is kept in, as one line of text: every kind of trigger and
  step, each field where it is kept and what it holds, and what a run knows
  of itself. A database keeps rules as their data; its fingerprint carries
  this line beside its SQL (@kraftverk/store), so a change to how a rule is
  kept sets an older database aside — and the home comes back from its
  configuration, written in words that do not change with it — rather than
  leaving rules that no longer say what they did.
*/

const fieldShape = (field: FieldSpec): string => `${field.data.join('.')}:${field.type.type}${field.required ? '!' : ''}`;

const kindsShape = <K extends string>(order: readonly K[], table: { readonly [k in K]: { fields: readonly FieldSpec[] } }): string =>
  order.map((kind) => `${kind}(${table[kind].fields.map(fieldShape).join(',')})`).join(' ');

/** How a rule is kept, as text: what a database's fingerprint carries beside its SQL. */
export const ruleShape = (): string =>
  [`when ${kindsShape(TRIGGER_KIND_ORDER, TRIGGER_KINDS)}`, `do ${kindsShape(STEP_KIND_ORDER, STEP_KINDS)}`, `expr ${[...EXPR_KIND_ORDER].sort().join(',')}`, `run ${RUN_FACTS.join(',')}`].join('; ');
