import { useCallback, useEffect, useState } from 'react';
import { Text, YStack } from 'tamagui';

import { describeError, type HomeModeView, type HomeView, type ModeView } from '@kraftverk/api-client';
import { Card, Chips, haptic, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';

/*
  Which mode each home is in (docs/PLAN-WORLD-MODEL.md §8.10): whether
  anyone is home, and the time of day — each changed with a tap, said as
  who set it and since when, and what is planned ahead. Read again as the
  home says a mode moved — an automation, presence, a vacation beginning.
*/

const clock = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** One axis in words: since when, who set it, and what comes next. */
export function modeLine(axis: HomeModeView): string {
  const now = axis.mode ? `${axis.mode.name} since ${time(axis.since!)}${axis.by ? `, set by ${axis.by}` : ''}` : 'Not said yet';
  const next = axis.ahead.find((each) => each.mode.id !== axis.mode?.id);
  return next ? `${now} · ${next.mode.name} from ${clock(next.from)}${next.until ? ` to ${clock(next.until)}` : ''}` : now;
}

export function useHomeModes(homeId: string | null): { modes: HomeModeView[] | null; all: ModeView[]; set: (mode: string) => Promise<void>; problem: string | null; reload: () => Promise<void> } {
  const { api } = useFamily();
  const { onWorld } = useDevices();
  const [modes, setModes] = useState<HomeModeView[] | null>(null);
  const [all, setAll] = useState<ModeView[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!homeId) return;
    try {
      const [of, list] = await Promise.all([api.modes.of(homeId), api.modes.list()]);
      setModes(of);
      setAll(list);
    } catch (err) {
      setProblem(describeError(err) || 'The modes could not be read');
    }
  }, [api, homeId]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => onWorld((what, at) => (what === 'mode' && (at === null || at === homeId) ? void reload() : undefined)), [onWorld, reload, homeId]);
  const set = useCallback(
    async (mode: string) => {
      if (!homeId) return;
      haptic();
      setProblem(null);
      try {
        setModes(await api.modes.set(homeId, { mode }));
      } catch (err) {
        setProblem(describeError(err) || 'The mode could not be set');
      }
    },
    [api, homeId]
  );
  return { modes, all, set, problem, reload };
}

/** A home's modes, on the home screen: tap to change. */
export function ModesCard({ home, titled }: { home: HomeView; titled: boolean }) {
  const { modes, all, set, problem } = useHomeModes(home.id);
  if (!modes) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{titled ? `${home.name}’s mode` : 'Mode'}</SectionLabel>
      <Card gap="$3">
        {modes.map((axis) => (
          <YStack key={axis.axis} gap="$1.5">
            <Chips
              label={axis.axis === 'presence' ? `Whether anyone is home, at ${home.name}` : `The time of day, at ${home.name}`}
              options={all.filter((mode) => mode.axis === axis.axis).map((mode) => ({ value: mode.id, label: mode.name }))}
              value={axis.mode?.id ?? null}
              onChange={(mode) => void set(mode)}
            />
            <Text fontSize={12} color="$muted">
              {modeLine(axis)}
            </Text>
          </YStack>
        ))}
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </Card>
    </YStack>
  );
}
