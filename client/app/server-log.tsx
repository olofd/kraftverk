import { useCallback, useEffect, useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import { Card, Row, RowSeparator, SectionLabel, SegmentedControl } from '@kraftverk/ui';
import { describeError, fetchServerLog } from '@kraftverk/api-client';
import type { ServerLogLine } from '@kraftverk/api-client';

import { Screen } from '../src/components/Screen';
import { useAuth } from '../src/state/AuthProvider';

/**
 * What the server has said lately.
 *
 * In a container nobody watches the console, so this is where to look first
 * when something is wrong: the same lines, newest first. The station's own
 * story — connections, disconnects and why — is the broker's journal, on the
 * station's Protocol screen.
 */

const LEVELS = [
  { value: 'info', label: 'Everything' },
  { value: 'warn', label: 'Problems' },
  { value: 'error', label: 'Errors' },
] as const satisfies readonly { value: ServerLogLine['level']; label: string }[];

type Level = (typeof LEVELS)[number]['value'];

export default function ServerLogScreen() {
  const { allowed } = useAuth();
  const [level, setLevel] = useState<Level>('info');
  const [lines, setLines] = useState<ServerLogLine[] | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const log = await fetchServerLog({ limit: 300, level }, signal);
        setLines(log.lines.slice().reverse());
        setDir(log.dir);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
      }
    },
    [level]
  );

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [load, allowed]);

  return (
    <Screen back="App settings" backTo="/app-settings" title="Server log" subtitle="What the server has said lately">
      <Card inset>
        <SegmentedControl title="Show" value={level} options={LEVELS} onChange={setLevel} />
      </Card>

      {error ? (
        <Text fontSize={13} color="$danger" paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Newest first</SectionLabel>
        <Card inset>
          {lines === null ? (
            <Row title="Loading…" />
          ) : lines.length === 0 ? (
            <Row title="Nothing yet" subtitle="Nothing at this level since the server started" />
          ) : (
            lines.map((line, index) => (
              <YStack key={`${line.at}-${index}`}>
                {index > 0 ? <RowSeparator /> : null}
                <XStack paddingHorizontal="$4" paddingVertical="$2" gap="$3" alignItems="flex-start">
                  <Text fontSize={11} color="$muted" fontVariant={['tabular-nums']} width={58} paddingTop={1}>
                    {hms(line.at)}
                  </Text>
                  <Text
                    flex={1}
                    fontSize={12}
                    lineHeight={17}
                    fontFamily="monospace"
                    color={line.level === 'error' ? '$danger' : line.level === 'warn' ? '$warning' : '$color'}
                  >
                    {line.text}
                  </Text>
                </XStack>
              </YStack>
            ))
          )}
        </Card>
        <Text fontSize={12} color="$muted" paddingHorizontal="$1" lineHeight={18}>
          Since the server last started.{' '}
          {dir
            ? `Every day's log, for the last two weeks, is on the server in ${dir}.`
            : 'This server keeps no log files.'}{' '}
          The station's connections and disconnects are in the broker journal, on the station's Protocol screen.
        </Text>
      </YStack>
    </Screen>
  );
}

/** 21:04:07, in every locale, so the time column keeps its width. */
function hms(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
