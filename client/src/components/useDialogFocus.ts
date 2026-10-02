import { useEffect, useRef, type RefObject } from 'react';
import { Platform } from 'react-native';

/** What a keyboard can reach inside a dialog. */
const FOCUSABLE = 'button, [href], input, select, textarea, [role="button"], [role="radio"], [tabindex="0"]';

/**
 * A dialog's keyboard, on the web, as a dialog's should be: focus starts
 * inside it — on `start`, or its first control — Tab and Shift-Tab go round
 * its controls and never out to the page behind, Escape closes it, and when
 * it closes, focus goes back to where the person was: what they pressed to
 * open it.
 *
 * `open` and `key`: it starts afresh whenever either changes — a queue of
 * questions, one after another, starts each on its own first control.
 */
export function useDialogFocus(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  onEscape: () => void,
  { start, key }: { start?: RefObject<HTMLElement | null>; key?: unknown } = {}
): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    const before = document.activeElement as HTMLElement | null;
    const focusable = () => (box.current ? [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);
    // After it is drawn: the element is not there to focus until then.
    const first = setTimeout(() => (start?.current ?? focusable()[0])?.focus(), 30);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const all = focusable();
      if (!all.length) return;
      const head = all[0]!;
      const tail = all[all.length - 1]!;
      const inside = box.current?.contains(document.activeElement) ?? false;
      if (event.shiftKey && (document.activeElement === head || !inside)) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (document.activeElement === tail || !inside)) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(first);
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
    // `box` and `start` are refs: read when a key is pressed, not when this runs.
  }, [open, key]);
}
