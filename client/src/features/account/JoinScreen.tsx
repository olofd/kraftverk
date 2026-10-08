import { PATHS } from '@kraftverk/api-client';

import { Text } from 'tamagui';

import { Card } from '@kraftverk/ui';

import { Screen } from '../../components/Screen';
import { keepsAccounts } from '../../state/AccountProvider';
import { JoinFamily } from './JoinFamily';

/** Joining another family, from App settings: an account can be in more than one, and the app shows one at a time. */
export function JoinScreen() {
  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Join a family" subtitle="With an invitation someone sent you">
      {keepsAccounts() ? (
        <JoinFamily />
      ) : (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            An invitation is taken by an account kept in this browser, and this page — plain HTTP — keeps none. Open the invitation over HTTPS.
          </Text>
        </Card>
      )}
    </Screen>
  );
}
