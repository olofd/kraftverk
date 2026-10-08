import { PATHS } from '@kraftverk/api-client';

import { Screen } from '../../components/Screen';
import { JoinFamily } from './JoinFamily';

/** Joining another family, from App settings: an account can be in more than one, and the app shows one at a time. */
export function JoinScreen() {
  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Join a family" subtitle="With an invitation someone sent you">
      <JoinFamily />
    </Screen>
  );
}
