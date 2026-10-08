import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type NotificationView } from '@kraftverk/api-client';
import { Card, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { thisNode } from '../../platform/node';
import { pushHere, pushSubscribed, subscribePush, unsubscribePush } from '../../platform/push';
import { useFamily } from '../../state/FamilyProvider';

/*
  What you were told (docs/PLAN-WORLD-MODEL.md §8.14): your inbox, newest
  first, read one by one or all at once — and, in App settings, whether this
  device is woken with them.
*/

const when = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function Inbox() {
  const { api } = useFamily();
  const [notifications, setNotifications] = useState<NotificationView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setNotifications(await api.notifications.list());
      setProblem(null);
    } catch (err) {
      setProblem(describeError(err) || 'Your notifications could not be read');
    }
  }, [api]);
  useEffect(() => void load(), [load]);
  const unread = notifications?.filter((each) => !each.readAt).length ?? 0;
  const readAll = async () => {
    haptic();
    await api.notifications.read(null).catch(() => undefined);
    await load();
  };

  return (
    <Screen back="Your devices" backTo={PATHS.home} title="Notifications" subtitle={unread ? `${unread} not read yet` : 'What kraftverk has told you'}>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!notifications && !problem ? <Spinner color="$accent" /> : null}
      {notifications && !notifications.length ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Nothing yet. What an automation tells you, and what needs you, will be here — and on this device, when it is woken with them (App settings).
          </Text>
        </Card>
      ) : null}
      {notifications?.length ? (
        <YStack gap="$2">
          <Card inset>
            {notifications.map((each, index) => (
              <YStack key={each.id}>
                {index ? <RowSeparator /> : null}
                <Row title={each.readAt ? each.title : `● ${each.title}`} subtitle={[each.body, `${each.from.name} · ${when(each.at)}`].filter(Boolean).join('\n')} />
              </YStack>
            ))}
          </Card>
          {unread ? (
            <XStack>
              <Button size="$3" minHeight={44} onPress={() => void readAll()}>
                Mark all read
              </Button>
            </XStack>
          ) : null}
        </YStack>
      ) : null}
    </Screen>
  );
}

/**
 * Whether this device is woken with your notifications, in App settings:
 * where it can be — a browser on a secure page, with a server that sends
 * pushes — and a test, to see one arrive.
 */
export function NotificationSettings() {
  const { api } = useFamily();
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const here = pushHere();
  useEffect(() => {
    void api.notifications
      .pushKey()
      .then(setKey)
      .catch(() => setKey(null));
    void pushSubscribed().then(setSubscribed);
  }, [api]);

  const doing = async (work: () => Promise<void>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };
  const wake = () =>
    doing(async () => {
      await api.notifications.keepPushEndpoint(thisNode().id, await subscribePush(key!));
      setSubscribed(true);
    }, 'This device could not be set to get them');
  const stop = () =>
    doing(async () => {
      await api.notifications.forgetPushEndpoint(thisNode().id);
      await unsubscribePush();
      setSubscribed(false);
    }, 'That could not be changed');
  const test = () =>
    doing(async () => {
      const sent = await api.notifications.test();
      setSaid(sent.deliveredAt ? 'Sent: it should show on this device in a moment.' : 'In your inbox: no device of yours was woken with it.');
    }, 'The test could not be sent');

  return (
    <YStack gap="$2">
      <SectionLabel>Notifications</SectionLabel>
      <Card gap="$3">
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {key === null
            ? 'Your family is kept where nothing sends a push: they wait in your inbox until you open the app.'
            : here.can !== true
              ? here.why
              : subscribed
                ? 'This device is woken with your notifications.'
                : 'Get your notifications on this device, even when kraftverk is closed.'}
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          {key && here.can === true ? (
            subscribed ? (
              <Button size="$3" minHeight={44} chromeless disabled={busy} onPress={() => void stop()}>
                Stop getting them here
              </Button>
            ) : (
              <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" disabled={busy} onPress={() => void wake()}>
                {busy ? <Spinner size="small" /> : 'Get them here'}
              </Button>
            )
          ) : null}
          <Button size="$3" minHeight={44} disabled={busy} onPress={() => void test()}>
            Send me a test
          </Button>
        </XStack>
        {said ? (
          <Text fontSize={13} color="$color" role="status">
            {said}
          </Text>
        ) : null}
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </Card>
    </YStack>
  );
}
