/**
 * "A person confirmed *this*" (docs/ARCHITECTURE.md §4.6).
 *
 * A constant anyone could send unprompted only said "someone meant something".
 * A refusal that wants a person's yes hands out a token bound to what was
 * asked — the device, part, command and arguments, or the patch, and who asked
 * — which expires in a minute and is good once. The retry presents it; a token
 * for another intent, another person, or one already used is no yes at all,
 * and the answer is a fresh question.
 */

const TTL_MS = 60_000;

/** A stable text of what is being confirmed: the same intent always reads the same, whatever order its keys came in. */
export function subjectOf(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]))
        : item;
  return JSON.stringify(sorted(value));
}

const token = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export class Confirmations {
  #pending = new Map<string, { subject: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A token for this subject, to hand to the person being asked. */
  ask(subject: string): string {
    const at = this.now();
    for (const [key, entry] of this.#pending) if (entry.expires <= at) this.#pending.delete(key);
    const issued = token();
    this.#pending.set(issued, { subject, expires: at + TTL_MS });
    return issued;
  }

  /** Whether this token was issued for this subject and is still good. Used once, either way. */
  accept(presented: string | undefined, subject: string): boolean {
    if (!presented) return false;
    const entry = this.#pending.get(presented);
    this.#pending.delete(presented);
    return entry !== undefined && entry.subject === subject && entry.expires > this.now();
  }
}
