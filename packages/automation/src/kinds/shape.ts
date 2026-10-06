import { STANDARD_MEANINGS } from '@kraftverk/device-sdk';

import { ROLE_FIELDS, RUN_FACTS } from '../rule.ts';
import { EXPR_KIND_ORDER } from './exprs.ts';
import type { FieldSpec } from './spec.ts';
import { STEP_KIND_ORDER, STEP_KINDS } from './steps.ts';
import { TRIGGER_FIELDS, TRIGGER_KIND_ORDER, TRIGGER_KINDS } from './triggers.ts';

/*
  The shape a rule is kept in, as one line of text: every kind of trigger and
  step, each field where it is kept and what it holds, what a run knows of
  itself, the standard meanings a reading names, and what a role holds. A
  database keeps rules as their data; its fingerprint carries this line
  beside its SQL (@kraftverk/store), so a change to how a rule is kept, or
  to the words it reads by, sets an older database aside — and the home comes back from its
  configuration, which its migrations bring up to date — rather than leaving
  rules that no longer say what they did.
*/

const fieldShape = (field: FieldSpec): string => `${field.data.join('.')}:${field.type.type}${field.required ? '!' : ''}`;

const kindsShape = <K extends string>(order: readonly K[], table: { readonly [k in K]: { fields: readonly FieldSpec[] } }): string =>
  order.map((kind) => `${kind}(${table[kind].fields.map(fieldShape).join(',')})`).join(' ');

/** How a rule is kept, as text: what a database's fingerprint carries beside its SQL. */
export const ruleShape = (): string =>
  [`when ${kindsShape(TRIGGER_KIND_ORDER, TRIGGER_KINDS)} any(${TRIGGER_FIELDS.map(fieldShape).join(',')})`, `do ${kindsShape(STEP_KIND_ORDER, STEP_KINDS)}`, `expr ${[...EXPR_KIND_ORDER].sort().join(',')}`, `run ${RUN_FACTS.join(',')}`, `means ${Object.keys(STANDARD_MEANINGS).sort().join(',')}`, `roles part(${ROLE_FIELDS.part.join(',')}) automation(${ROLE_FIELDS.automation.join(',')})`].join('; ');
