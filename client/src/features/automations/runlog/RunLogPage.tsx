import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, fetchAutomation, fetchRunLog, fetchRunLogCsv, type AutomationView, type RunLog } from '@kraftverk/api-client';
import { Card, Chips, Icon, ToggleRow } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { Screen } from '../../../components/Screen';
import { fileNameOf, saveText } from '../../../lib/download';
import { dayOf, lasted, OUTCOME, useTone } from '../looks';
import { Empty, Group } from '../page/Group';
import { Mark as OutcomeMark } from '../page/history';
import { useReadAgain } from '../useReadAgain';
import { awayOf, RunChart, Ruler } from './RunChart';
import { changed, marksOf, said, seriesOf, sinceStart, windowOf, type Mark } from '@kraftverk/automation-engine';

/*
  A run's log, a page of its own (docs/SEQUENCES.md): how it came out; every
  step it took, those that changed something numbered; every value each
  device gave while it ran, drawn across the run with the steps marked and a
  cursor that reads them all at one moment; every reading in time order; and
  the whole of it to download — as a table, or raw.
*/

/** How many readings are listed before "Show all". */
const LISTED = 200;
/** A reading heard this much after it was taken is said to have come late. */
const LATE_MS = 2_000;
/** While it runs, its log is read again this often. */
const RUNNING_EVERY_MS = 2_000;

export function RunLogPage({ id, runId }: { id: string; runId: string }) {
  const [log, setLog] = useState<RunLog | null>(null);
  const [automation, setAutomation] = useState<AutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([fetchRunLog(id, runId), fetchAutomation(id)])
      .then(([kept, owner]) => (setLog(kept), setAutomation(owner), setError(null)))
      .catch((caught: unknown) => setError(describeError(caught)));
  }, [id, runId]);
  useEffect(load, [load]);
  useReadAgain(load, { followReadings: false });
  // While it runs, its devices keep talking: read again every couple of seconds until it ends.
  const running = log?.run.outcome === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, RUNNING_EVERY_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const back = automation?.name ?? 'Automation';
  if (!log) {
    return (
      <Screen back={back} backTo={`/automation/${id}`} title="Run log">
        {error ? (
          <Card borderColor="$danger">
            <Text fontSize={14} color="$danger">
              {error}
            </Text>
          </Card>
        ) : (
          <Spinner color="$accent" />
        )}
      </Screen>
    );
  }
  return (
    <Screen back={back} backTo={`/automation/${id}`} title="Run log" subtitle={`${dayOf(log.run.at)} ${new Date(log.run.at).toLocaleTimeString()}`}>
      <Log log={log} name={automation?.name ?? 'run'} automationId={id} />
    </Screen>
  );
}

function Log({ log, name, automationId }: { log: RunLog; name: string; automationId: string }) {
  const window = windowOf(log);
  const marks = useMemo(() => marksOf(log.run), [log.run]);
  const all = useMemo(() => seriesOf(log, window), [log, window.from, window.to]);
  const [device, setDevice] = useState<string>('all');
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [cursor, setCursor] = useState<number | null>(null);

  const shown = all.filter((series) => (device === 'all' || series.key.device === device) && series.points.length && (!onlyChanged || changed(series)));
  const devices = log.devices.filter((each) => device === 'all' || each.id === device);
  return (
    <YStack gap="$4">
      <Outcome log={log} name={name} automationId={automationId} />
      <Steps log={log} marks={marks} window={window} onCursor={setCursor} />

      <Group icon="activity" title="Values" summary={`${log.keys.length}`}>
        {log.devices.length > 1 ? (
          <Chips label="Which device" options={[{ value: 'all', label: 'All' }, ...log.devices.map((each) => ({ value: each.id, label: each.name }))]} value={device} onChange={setDevice} />
        ) : null}
        <ToggleRow title="Only what changed" subtitle="Leave out values that stayed the same the whole run, and readings that said nothing new." checked={onlyChanged} onCheckedChange={setOnlyChanged} />
        <CursorBar cursor={cursor} window={window} marks={marks} onCursor={setCursor} />
        <Ruler window={window} marks={marks} cursor={cursor} onCursor={setCursor} />
        {devices.map((each) => {
          const values = shown.filter((series) => series.key.device === each.id);
          const roles = log.roles.filter((role) => role.device === each.id).map((role) => role.label);
          const away = awayOf(log.reach, each.id, window);
          return (
            <YStack key={each.id} gap="$3" role="group" aria-label={each.name}>
              <YStack gap={2}>
                <Text role="heading" aria-level={3} fontSize={15} fontWeight="700" color="$color">
                  {each.name}
                </Text>
                <Text fontSize={12} color="$muted" lineHeight={17}>
                  {[roles.join(', '), away.length ? `out of reach ${away.length === 1 ? 'once' : `${away.length} times`} — shaded` : ''].filter(Boolean).join(' · ')}
                </Text>
              </YStack>
              {values.length ? (
                values.map((series) => <RunChart key={series.key.key} series={series} window={window} marks={marks} away={away} cursor={cursor} onCursor={setCursor} />)
              ) : (
                <Empty>{onlyChanged ? 'Nothing it gave changed while it ran.' : 'It gave nothing while it ran.'}</Empty>
              )}
            </YStack>
          );
        })}
      </Group>

      <Readings log={log} device={device} onlyChanged={onlyChanged} window={window} />
    </YStack>
  );
}

/** How it came out, when, and the whole log to take away. */
function Outcome({ log, name, automationId }: { log: RunLog; name: string; automationId: string }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const look = OUTCOME[log.run.outcome];
  const save = async (as: 'csv' | 'json') => {
    setSaving(as);
    setProblem(null);
    try {
      const fileName = fileNameOf(name, log.run.at, as);
      if (as === 'csv') await saveText(fileName, await fetchRunLogCsv(automationId, log.run.id!), 'text/csv');
      else await saveText(fileName, JSON.stringify(log, null, 2), 'application/json');
    } catch (caught) {
      setProblem(describeError(caught));
    } finally {
      setSaving(null);
    }
  };
  const times = `${new Date(log.run.at).toLocaleTimeString()}${log.run.endedAt ? ` – ${new Date(log.run.endedAt).toLocaleTimeString()}` : ' – running'}`;
  return (
    <Card gap="$3">
      <XStack gap="$3" alignItems="flex-start">
        <OutcomeMark look={look} />
        <YStack flex={1} gap={2}>
          <Text fontSize={15} fontWeight="700" color="$color" lineHeight={21}>
            {log.run.summary}
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {log.run.why} · {times}
            {lasted(log.run)}
          </Text>
        </YStack>
      </XStack>
      <Text fontSize={12} color="$muted" lineHeight={17}>
        {`${log.readings.length} readings from ${log.devices.length} ${log.devices.length === 1 ? 'device' : 'devices'}, each at the time the device took it.`}
        {log.capped ? ' It gave more than a run keeps: the last of them are not here.' : ''}
      </Text>
      <XStack gap="$2" flexWrap="wrap">
        <Button size="$3" minHeight={44} icon={saving === 'csv' ? <Spinner size="small" /> : <Icon name="download" size={16} />} disabled={saving !== null} onPress={() => void save('csv')}>
          Download as a table
        </Button>
        <Button size="$3" minHeight={44} icon={saving === 'json' ? <Spinner size="small" /> : <Icon name="code" size={16} />} disabled={saving !== null} onPress={() => void save('json')}>
          Download raw
        </Button>
      </XStack>
      {problem ? (
        <Text fontSize={13} color="$danger">
          {problem}
        </Text>
      ) : null}
    </Card>
  );
}

/** Every step it took, when, and how it went — those that changed something numbered as the charts mark them; a tap reads every value then. */
function Steps({ log, marks, window, onCursor }: { log: RunLog; marks: readonly Mark[]; window: ReturnType<typeof windowOf>; onCursor: (at: number) => void }) {
  const tone = useTone();
  const numbers = new Map(marks.map((mark) => [mark.step, mark.n]));
  let within: string | null = null;
  return (
    <Group icon="list" title="Steps" summary={`${log.run.steps.length}`}>
      {log.run.steps.length ? (
        <YStack role="list" aria-label="Steps" gap="$1">
          {log.run.steps.map((step, index) => {
            const n = numbers.get(step);
            const heading = step.within && step.within !== within ? step.within : null;
            within = step.within;
            const failed = step.outcome === 'failed' || step.outcome === 'refused' || step.outcome === 'timed-out';
            return (
              <YStack key={`${index} ${step.at}`} gap={2}>
                {heading ? (
                  <Text fontSize={12} fontWeight="700" color="$muted" marginTop="$2" paddingLeft={step.depth * 14}>
                    {heading}
                  </Text>
                ) : null}
                <Pressable onPress={() => onCursor(Date.parse(step.at))} label={`${step.what}, ${sinceStart(Date.parse(step.at), window)}: read every value then`}>
                  <XStack role="listitem" gap="$2" alignItems="flex-start" minHeight={40} paddingVertical={4} paddingLeft={step.depth * 14}>
                    <YStack width={22} height={22} borderRadius={11} alignItems="center" justifyContent="center" backgroundColor={n ? (failed ? '$warning' : '$accent') : 'transparent'}>
                      {n ? (
                        <Text fontSize={11} fontWeight="800" color="$background">
                          {n}
                        </Text>
                      ) : (
                        <Icon name="circle" size={6} color={tone('$muted')} />
                      )}
                    </YStack>
                    <Text fontSize={12} color="$muted" width={52} lineHeight={22} fontVariant={['tabular-nums']}>
                      {sinceStart(Date.parse(step.at), window)}
                    </Text>
                    <YStack flex={1}>
                      <Text fontSize={14} color="$color" lineHeight={22}>
                        {step.what}
                      </Text>
                      <Text fontSize={12} color={failed ? '$warning' : '$muted'} lineHeight={17}>
                        {step.detail}
                      </Text>
                    </YStack>
                  </XStack>
                </Pressable>
              </YStack>
            );
          })}
        </YStack>
      ) : (
        <Empty>It took no steps.</Empty>
      )}
    </Group>
  );
}

/** Where the cursor stands, and the way from one numbered step to the next — by keyboard too. */
function CursorBar({ cursor, window, marks, onCursor }: { cursor: number | null; window: ReturnType<typeof windowOf>; marks: readonly Mark[]; onCursor: (at: number | null) => void }) {
  const before = cursor === null ? undefined : [...marks].reverse().find((mark) => mark.at < cursor);
  const after = marks.find((mark) => cursor === null || mark.at > cursor);
  return (
    <XStack alignItems="center" gap="$2" flexWrap="wrap" role="toolbar" aria-label="Cursor">
      <Text fontSize={13} color={cursor === null ? '$muted' : '$color'} flex={1} minWidth={160} role="status">
        {cursor === null ? 'Tap a chart to read every value at one moment.' : `At ${sinceStart(cursor, window, true)} · ${new Date(cursor).toLocaleTimeString()}`}
      </Text>
      <Button size="$3" minHeight={44} minWidth={44} chromeless icon={<Icon name="chevron-left" size={16} />} disabled={!before} aria-label="To the step before" onPress={() => before && onCursor(before.at)} />
      <Button size="$3" minHeight={44} minWidth={44} chromeless icon={<Icon name="chevron-right" size={16} />} disabled={!after} aria-label="To the next step" onPress={() => after && onCursor(after.at)} />
      {cursor !== null ? (
        <Button size="$3" minHeight={44} chromeless onPress={() => onCursor(null)}>
          Clear
        </Button>
      ) : null}
    </XStack>
  );
}

/**
 * Every reading, and every change in whether a device could be reached, in
 * time order — each when the device took it, and how late it was heard. With
 * only what changed: a value said again is left out.
 */
function Readings({ log, device, onlyChanged, window }: { log: RunLog; device: string; onlyChanged: boolean; window: ReturnType<typeof windowOf> }) {
  const [all, setAll] = useState(false);
  const names = new Map(log.devices.map((each) => [each.id, each.name]));
  const keys = new Map(log.keys.map((key) => [`${key.device} ${key.key}`, key]));
  const before = new Map<string, string>();
  const news = onlyChanged
    ? log.readings.filter((reading) => {
        const id = `${reading.device} ${reading.key}`;
        const value = JSON.stringify(reading.value);
        if (before.get(id) === value) return false;
        before.set(id, value);
        return true;
      })
    : log.readings;
  const lines = [
    ...news.map((reading) => {
      const key = keys.get(`${reading.device} ${reading.key}`);
      const late = Date.parse(reading.heardAt) - Date.parse(reading.at);
      return {
        id: `r ${reading.device} ${reading.key} ${reading.at}`,
        at: Date.parse(reading.at),
        device: reading.device,
        text: `${key?.label ?? reading.key}: `,
        value: key ? said(key, reading.value) : JSON.stringify(reading.value),
        note: late > LATE_MS ? `heard ${(late / 1000).toFixed(1)} s later` : null,
      };
    }),
    ...log.reach.map((reach) => ({ id: `h ${reach.device} ${reach.at}`, at: Date.parse(reach.at), device: reach.device, text: '', value: reach.reachable ? 'can be reached' : 'out of reach', note: reach.reachable ? null : reach.detail })),
  ]
    .filter((line) => device === 'all' || line.device === device)
    .sort((a, b) => a.at - b.at);
  const listed = all ? lines : lines.slice(0, LISTED);
  return (
    <Group icon="file-text" title="Every reading" summary={`${lines.length}`}>
      {lines.length ? (
        <YStack role="list" aria-label="Every reading" gap={3}>
          {listed.map((line) => (
            <XStack key={line.id} role="listitem" gap="$2" alignItems="flex-start">
              <Text fontSize={12} color="$muted" width={58} lineHeight={18} fontVariant={['tabular-nums']}>
                {sinceStart(line.at, window, true)}
              </Text>
              <Text fontSize={12} color="$color" lineHeight={18} flex={1}>
                {names.get(line.device) ?? line.device} · {line.text}
                <Text fontWeight="700">{line.value}</Text>
                {line.note ? <Text color="$muted">{` (${line.note})`}</Text> : null}
              </Text>
            </XStack>
          ))}
          {lines.length > listed.length ? (
            <Button size="$3" minHeight={44} chromeless alignSelf="flex-start" color="$accent" onPress={() => setAll(true)}>
              {`Show all ${lines.length}`}
            </Button>
          ) : null}
        </YStack>
      ) : (
        <Empty>Nothing was kept for this run.</Empty>
      )}
    </Group>
  );
}
