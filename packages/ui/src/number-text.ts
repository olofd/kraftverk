import { useEffect, useState } from 'react';

/** A number as typed — "1,5" or "1.5" — or null when it is none yet. */
export const parseNumberText = (text: string): number | null => {
  const number = Number(text.replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(number) ? null : number;
};

/**
 * A number as it is typed — kept as text while it is typed, so "1." or "-0"
 * is not lost on the way to "1.5" or "-0.5" — and given back as a number once
 * it is one. `shown`: how it reads when it is not being typed. A value
 * changed from outside is shown; what is being typed stays as typed.
 */
export function useNumberText(value: number | null, shown: (value: number) => string = String) {
  const [text, setText] = useState(value === null ? '' : shown(value));
  useEffect(() => {
    if (parseNumberText(text) !== value) setText(value === null ? '' : shown(value));
  }, [value]);
  return { text, setText, parse: parseNumberText };
}
