import { useRef } from 'react';

type Key = { key: string; preventDefault: () => void };

/**
 * A radio group's keyboard, for options drawn as views: one Tab stop — the
 * chosen option, or the first when none is — the arrows move between the
 * options, and Space or Enter chooses the one it is on. Moving does not
 * choose: a choice can be consequential (letting an automation act asks
 * first), so it is made on purpose, never by passing over it.
 *
 * `radio(index)` gives what each option spreads onto its view.
 */
export function useRadioGroup(count: number, chosen: number, choose: (index: number) => void) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const stop = Math.max(0, chosen);
  return (index: number) => ({
    ref: ((element: HTMLElement | null) => void (refs.current[index] = element)) as never,
    tabIndex: index === stop ? 0 : -1,
    onKeyDown: ((event: Key) => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        event.preventDefault();
        refs.current[(index + step + count) % count]?.focus();
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        choose(index);
      }
    }) as never,
  });
}
