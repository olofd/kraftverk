import { useLocalSearchParams } from 'expo-router';

import { RunLogPage } from '../../../../src/features/automations/runlog/RunLogPage';

/** One run of an automation, read back: its steps, and every value its devices gave while it ran. */
export default function RunLogScreen() {
  const { id, run } = useLocalSearchParams<{ id: string; run: string }>();
  return <RunLogPage id={id} runId={run} />;
}
