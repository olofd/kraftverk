import { useRef, useState } from 'react';

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

/**
 * A group of toggles' keyboard — the days of a week, each on or off — as a
 * radio group's is: one Tab stop, the one last moved to (the first, at
 * first); the arrows, Home and End move between them; Space or Enter turns
 * the one it is on. Seven toggles are one stop on the way through a form,
 * not seven.
 *
 * `toggle(index)` gives what each spreads onto its view.
 */
export function useToggleGroup(count: number, turn: (index: number) => void) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const [stop, setStop] = useState(0);
  const move = (to: number) => {
    const next = (to + count) % count;
    setStop(next);
    refs.current[next]?.focus();
  };
  return (index: number) => ({
    ref: ((element: HTMLElement | null) => void (refs.current[index] = element)) as never,
    tabIndex: index === stop ? 0 : -1,
    onFocus: (() => setStop(index)) as never,
    onKeyDown: ((event: Key) => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        event.preventDefault();
        move(index + step);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        move(event.key === 'Home' ? 0 : count - 1);
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        turn(index);
      }
    }) as never,
  });
}
