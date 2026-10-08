import type { Expr } from './rule.ts';
import { parseExpr, type ExprError } from './text/expr.ts';

/*
  Words with values in them — what a notification says: "The charge is
  {station.charge}", "{run.who} is home". Each value in braces is an
  expression, checked as any is, and said as it is when the run takes the
  step: a number in its unit, a yes or no, a name. "{{" is a brace itself.
*/

/** A message's pieces, in order: words as written, and expressions to say. */
export type MessagePiece = { text: string } | { expr: Expr; source: string };

/** A message read, or where it goes wrong: a brace not closed, an expression that is not one. */
export type ParsedMessage = { ok: true; pieces: MessagePiece[] } | { ok: false; error: ExprError };

export function parseMessage(text: string): ParsedMessage {
  const pieces: MessagePiece[] = [];
  let words = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === '{' && text[at + 1] === '{') {
      words += '{';
      at++;
      continue;
    }
    if (char === '}' && text[at + 1] === '}') {
      words += '}';
      at++;
      continue;
    }
    if (char !== '{') {
      words += char;
      continue;
    }
    const end = text.indexOf('}', at + 1);
    if (end < 0) return { ok: false, error: { message: 'A "{" is not closed: it needs its "}"', offset: at } };
    const source = text.slice(at + 1, end).trim();
    if (!source) return { ok: false, error: { message: 'Braces hold a value to say: {station.charge}', offset: at } };
    const parsed = parseExpr(source);
    if (!parsed.ok) return { ok: false, error: { message: parsed.error.message, offset: at + 1 + parsed.error.offset } };
    if (words) pieces.push({ text: words });
    words = '';
    pieces.push({ expr: parsed.expr, source });
    at = end;
  }
  if (words) pieces.push({ text: words });
  return { ok: true, pieces };
}

/** The expressions a message says, in order: what a walk over a rule reads. */
export const messageExprs = (text: string): Expr[] => {
  const parsed = parseMessage(text);
  return parsed.ok ? parsed.pieces.flatMap((piece) => ('expr' in piece ? [piece.expr] : [])) : [];
};

/** A message with each value said by `say`: what a person reads. */
export function sayMessage(text: string, say: (expr: Expr, source: string) => string): string {
  const parsed = parseMessage(text);
  if (!parsed.ok) return text;
  return parsed.pieces.map((piece) => ('text' in piece ? piece.text : say(piece.expr, piece.source))).join('');
}
