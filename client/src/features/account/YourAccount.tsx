import { useState } from 'react';
import { Button, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import { Card, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { confirmAction } from '../../platform/confirm';
import { useAccount } from '../../state/AccountProvider';

/**
 * Who uses this app, in App settings (docs/PLAN-WORLD-MODEL.md §10.6): the
 * account it opens as, and what it links; signing out — back to the
 * accounts this device keeps, its key kept — and removing it from this
 * device, its key gone with it.
 */
export function YourAccount() {
  const { account, accounts, personal, signOut, reload } = useAccount();
  const [problem, setProblem] = useState<string | null>(null);
  const others = accounts.length - 1;

  const remove = async () => {
    const ways = account.linked.length ? 'your recovery words, or by signing in with what you linked where your family takes it' : 'your recovery words';
    if (!(await confirmAction(`Remove ${account.name} from this device?`, `Its key goes, and this device can no longer open it. Its families stay where they are kept. Coming back to it on this device takes ${ways}.`, 'Remove', 'dangerous'))) return;
    haptic();
    try {
      await personal.remove(account.personId);
      await reload();
    } catch (err) {
      setProblem(describeError(err) || 'It could not be removed');
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>You</SectionLabel>
      <Card inset>
        <Row
          title={account.name}
          subtitle={[`On ${account.deviceName}`, account.linked.length ? `linked: ${account.linked.map((each) => each.email ?? each.provider).join(', ')}` : 'a local account', account.recoveryConfirmed ? null : 'recovery words never checked'].filter(Boolean).join(' · ')}
        />
        <RowSeparator />
        <Row
          title={others ? 'Switch account' : 'Sign out'}
          subtitle={others ? `${others} other account${others === 1 ? '' : 's'} on this device; or add one` : 'Back to the start: this device keeps your account, to open again with a tap'}
          accessory={
            <Button size="$3" minHeight={44} onPress={() => (haptic(), void signOut())}>
              {others ? 'Switch' : 'Sign out'}
            </Button>
          }
        />
        <RowSeparator />
        <Row
          title="Remove from this device"
          subtitle="Its key goes with it: coming back takes your recovery words"
          accessory={
            <Button size="$3" minHeight={44} chromeless color="$danger" onPress={() => void remove()}>
              Remove
            </Button>
          }
        />
      </Card>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
    </YStack>
  );
}
