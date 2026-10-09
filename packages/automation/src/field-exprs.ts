import { EXPRESSION_FIELDS, type FieldType } from './kinds/spec.ts';
import { mapMessage, messageExprs } from './message.ts';
import type { Expr } from './rule.ts';

/*
  The expressions a field holds, by what it holds: one; a command's
  arguments, each one; a message's values in braces. What every walk over a
  rule — what it reads, its settings written in, each part read as its
  group — asks of a field, so a kind of field that holds expressions is
  never missed by one of them.
*/

/** The expressions a field's value holds at its top: none, for a field that holds none. */
export function fieldExprs(type: FieldType, value: unknown): Expr[] {
  if (value === undefined) return [];
  if (EXPRESSION_FIELDS.has(type.type)) return [value as Expr];
  if (type.type === 'args') return Object.values(value as Record<string, Expr>);
  if (type.type === 'message') return messageExprs(String(value));
  return [];
}

/** A field's value with each expression it holds changed; one that holds none, as it was. */
export function mapFieldExprs(type: FieldType, value: unknown, change: (expr: Expr) => Expr): unknown {
  if (value === undefined) return value;
  if (EXPRESSION_FIELDS.has(type.type)) return change(value as Expr);
  if (type.type === 'args') return Object.fromEntries(Object.entries(value as Record<string, Expr>).map(([name, arg]) => [name, change(arg)]));
  if (type.type === 'message') return mapMessage(String(value), change);
  return value;
}
