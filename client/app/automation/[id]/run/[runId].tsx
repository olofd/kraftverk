import { useLocalSearchParams } from 'expo-router';

import { RunLogPage } from '../../../../src/features/automations/runlog/RunLogPage';

/** One run of an automation, read back: its steps, and every value its devices gave while it ran. */
export default function RunLogScreen() {
  const { id, runId } = useLocalSearchParams<{ id: string; runId: string }>();
  return <RunLogPage id={id} runId={runId} />;
}
