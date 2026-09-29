import { useEffect, useState } from 'react';
import { Card, EventList } from '@kraftverk/ui';
import { Spinner, Text, YStack } from 'tamagui';

import { describeError, type DeviceView, type ProblemView } from '@kraftverk/api-client';

import { Screen } from '../src/components/Screen';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * What wants looking at: every warning and error your devices said happened,
 * newest first, each by its device and part — read again when the live
 * stream carries an event. The server keeps them; local mode keeps none.
 */
export default function ProblemsScreen() {
  const { problems, devices, heard } = useDevices();
  const [list, setList] = useState<ProblemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!problems) return;
    const controller = new AbortController();
    void problems(100, controller.signal)
      .then((found) => {
        setList(found);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err) || 'They could not be read'));
    return () => controller.abort();
  }, [heard?.count, problems]);

  const described = new Map<string, DeviceView['description']>(devices.map((device) => [device.id, device.description]));

  return (
    <Screen back="Your devices" title="Problems" subtitle="Warnings and errors your devices reported">
      {!problems ? (
        <Card padding="$4">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Without a server nothing is kept: what a device says happened is only heard while this app holds it.
          </Text>
        </Card>
      ) : error ? (
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
