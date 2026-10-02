import { useCallback, useEffect, useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import type { ServerLogLine } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SectionLabel, SegmentedControl } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAuth } from '../../state/AuthProvider';
import { useServers } from '../../state/ServersProvider';

/**
 * What the server has said lately.
 *
 * In a container nobody watches the console, so this is where to look first
 * when something is wrong: the same lines, newest first. A device's own
 * story — connections, disconnects and why — is the broker's journal, a
 * diagnostic on the Connectivity screen.
 */

const LEVELS = [
  { value: 'info', label: 'Everything' },
  { value: 'warn', label: 'Problems' },
  { value: 'error', label: 'Errors' },
] as const satisfies readonly { value: ServerLogLine['level']; label: string }[];

type Level = (typeof LEVELS)[number]['value'];

export function ServerLog() {
  const { allowed } = useAuth();
  const { server } = useServers();
  const [level, setLevel] = useState<Level>('info');
  const [lines, setLines] = useState<ServerLogLine[] | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        if (!server) return;
        const log = await server.log({ limit: 300, level });
        // Asked again, or gone: what came back is not this screen's any more.
        if (signal?.aborted) return;
        setLines(log.lines.slice().reverse());
        setDir(log.dir);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
      }
    },
    [level, server]
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
        <ErrorText paddingHorizontal="$1">
          {error}
        </ErrorText>
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
          When devices connected and disconnected, and why, is in the broker's journal, under App settings → Connectivity.
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
