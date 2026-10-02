import { useEffect, useState } from 'react';
import { Card, EventList } from '@kraftverk/ui';
import { Spinner, Text, YStack } from 'tamagui';

import { describeError, type DeviceView, type ProblemView } from '@kraftverk/api-client';

import { Screen } from '../src/components/Screen';
import { useDevices } from '../src/state/DevicesProvider';
import { useHome } from '../src/state/HomeProvider';

/**
 * What wants looking at: every warning and error your devices said happened,
 * newest first, each by its device and part — read again when the live
 * stream carries an event. The home keeps them, wherever it is.
 */
export default function ProblemsScreen() {
  const { devices, heard } = useDevices();
  const { api } = useHome();
  const [list, setList] = useState<ProblemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .problems(100)
      .then((found) => {
        if (!live) return;
        setList(found);
        setError(null);
      })
      .catch((err: unknown) => live && setError(describeError(err) || 'They could not be read'));
    return () => {
      live = false;
    };
  }, [api, heard?.count]);

  const described = new Map<string, DeviceView['description']>(devices.map((device) => [device.id, device.description]));

  return (
    <Screen back="Your devices" title="Problems" subtitle="Warnings and errors your devices reported">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
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
