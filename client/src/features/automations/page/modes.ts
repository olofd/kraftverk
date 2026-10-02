import type { AutomationMode } from '@kraftverk/api-client';
import type { IconName } from '@kraftverk/ui';

import type { Look } from '../looks';

/*
  What an automation does on its own, in words: its modes, keeping things
  so, and the changes made to it — on its page and in its history.
*/

export const MODES: { value: AutomationMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'watch', label: 'Watch only' },
  { value: 'act', label: 'Act' },
];

/** What each mode means for what it does on its own — for one with nothing that starts it, what is left. */
export const modeSays = (mode: AutomationMode, onItsOwn: boolean): string =>
  onItsOwn
    ? {
        off: 'It does nothing, and cannot be started.',
        watch: 'On its own, it decides and says here what it would have done: nothing is switched. Started by you, it acts.',
        act: 'It acts on its own, through the same checks as a tap on a switch.',
      }[mode]
    : {
        off: 'It cannot be started.',
        watch: 'Started by you, it acts; an assistant cannot start it until you let it act.',
        act: 'Started by you, another automation or an assistant, it acts.',
      }[mode];

/** How often it may look again to keep things so, in minutes; 0 is never. */
export const RECHECK: { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
];

export const every = (minutes: number) => (minutes === 60 ? 'hour' : `${minutes} min`);

/** What keeping things so means, for the choice as it stands. */
export const recheckSays = (minutes: number | null) =>
  minutes
    ? `Every ${every(minutes)}, a condition that still holds runs it again: something switched by hand against it is switched back. What is already so is left alone.`
    : 'Once it has acted, it leaves things be until a condition comes true again: you can switch by hand in between.';

/** Each mode its own shape as well as its colour: acting is filled, and cannot be mistaken for watching. */
export const BADGE: Record<AutomationMode, { label: string; icon: IconName; filled: boolean }> = {
  off: { label: 'Off', icon: 'pause', filled: false },
  watch: { label: 'Only watching', icon: 'eye', filled: false },
  act: { label: 'Acting', icon: 'zap', filled: true },
};

/** A change made to an automation, as its history shows it. */
export const CHANGE: Record<string, Look> = {
  'automation.created': { icon: 'plus', tone: '$color' },
  'automation.proposed': { icon: 'message-circle', tone: '$color' },
  'automation.armed': { icon: 'zap', tone: '$success' },
  'automation.changed': { icon: 'edit-3', tone: '$color' },
  'automation.started': { icon: 'play', tone: '$accent' },
  'automation.stopping': { icon: 'square', tone: '$muted' },
};
