import { Spinner, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';
import { Card, EventList } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

/**
 * What wants looking at: every warning and error your devices said happened,
 * newest first, each by its device and part — read again when the live
 * stream carries an event. The home keeps them, wherever it is.
 */
/** How many problems are read: the newest, across every device. */
export const PROBLEMS_SHOWN = 100;

export function ProblemsScreen() {
  const { devices, heard } = useDevices();
  const { api } = useHome();

  const { value: list, error } = useAnswer(() => api.problems(PROBLEMS_SHOWN), [api, heard?.count], { failure: 'They could not be read' });

  const described = new Map<string, DeviceView['description']>(devices.map((device) => [device.id, device.description]));

  return (
    <Screen back="Your devices" title="Problems" subtitle="Warnings and errors your devices reported">
      {error ? (
        <Card borderColor="$danger">
          <ErrorText>
            {error}
          </ErrorText>
        </Card>
      ) : !list ? (
        <YStack padding="$5" alignItems="center">
          <Spinner color="$accent" />
        </YStack>
      ) : (
        <EventList
          title="Newest first"
          events={list.map((problem) => ({ key: problem.id, event: problem.event, level: problem.level, part: problem.part, at: problem.at, deviceName: problem.deviceName, deviceId: problem.deviceId }))}
          describe={(event) => (event.deviceId ? (described.get(event.deviceId) ?? null) : null)}
          empty="None: no device has reported a warning or an error."
        />
      )}
    </Screen>
  );
}
