
import { changeAutomation, withConfirmation, type AutomationChanges, type AutomationView } from '@kraftverk/api-client';
import type { AutomationMode } from '@kraftverk/api-client';
import { keepsSo } from '@kraftverk/automation';
import { RowSeparator, SegmentedControl, ToggleRow } from '@kraftverk/ui';

import { ErrorText } from '../../../components/ErrorText';
import { useAttempt } from '../../../components/useAttempt';
import { ask } from '../../../platform/confirm';
import { useHome } from '../../../state/HomeProvider';
import { every } from '../looks';
import { Group } from './Group';

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

/** What keeping things so means, for the choice as it stands. */
export const recheckSays = (minutes: number | null) =>
  minutes
    ? `Every ${every(minutes)}, a condition that still holds runs it again: something switched by hand against it is switched back. What is already so is left alone.`
    : 'Once it has acted, it leaves things be until a condition comes true again: you can switch by hand in between.';

/** What it does on its own: off, only watching, or acting — keeping things so, and a place on the home page. */
export function OnItsOwn({ automation, onChanged }: { automation: AutomationView; onChanged: (next: AutomationView) => void }) {
  const { api } = useHome();
  const { busy, error: problem, attempt } = useAttempt();
  const onItsOwn = automation.when.length > 0;
  const canKeep = keepsSo(automation.rule);

  const act = (work: () => Promise<void>, failure: string) => attempt(work, failure);
  /** A change the server may want a yes for: asked in its words, again if the yes came too late. */
  const change = (changes: AutomationChanges, title: string, yes: string) =>
    act(async () => {
      const { answer } = await withConfirmation(
        (confirmation) => changeAutomation(api, automation.id, { ...changes, confirmation }),
        (reason) => ({ title, message: `${reason}\n\n${automation.sentence}`, yes }),
        ask
      );
      if ('automation' in answer) onChanged(answer.automation);
    }, 'That did not work');

  return (
    <Group icon="zap" title={onItsOwn ? 'On its own' : 'When others start it'} inset>
      <SegmentedControl
        title="Mode"
        subtitle={modeSays(automation.mode, onItsOwn)}
        value={automation.mode}
        options={MODES}
        disabled={busy}
        onChange={(mode) => void change({ mode }, onItsOwn ? `Let “${automation.name}” act on its own?` : `Let “${automation.name}” act when others start it?`, 'Let it act')}
      />
      {canKeep ? (
        <>
          <RowSeparator />
          <SegmentedControl
            title="Keep it so"
            subtitle={recheckSays(automation.recheckMinutes)}
            value={automation.recheckMinutes ?? 0}
            options={RECHECK}
            disabled={busy}
            onChange={(minutes) =>
              void change(
                { recheckMinutes: minutes || null },
                minutes ? `Check “${automation.name}” every ${every(minutes)}?` : `Stop checking “${automation.name}” again?`,
                minutes ? `Every ${every(minutes)}` : 'Stop'
              )
            }
          />
        </>
      ) : null}
      <RowSeparator />
      <ToggleRow
        title="On the home page"
        subtitle={automation.homePlace === null ? 'A shortcut to run it, on your home page.' : 'Its card is on your home page.'}
        checked={automation.homePlace !== null}
        disabled={busy}
        onCheckedChange={(on) =>
          void act(async () => {
            const answer = await changeAutomation(api, automation.id, { homePlace: on ? 1000 : null });
            if ('automation' in answer) onChanged(answer.automation);
          }, 'That did not work')
        }
      />
      {problem ? (
        <ErrorText paddingHorizontal="$4" paddingBottom="$3">
          {problem}
        </ErrorText>
      ) : null}
    </Group>
  );
}
