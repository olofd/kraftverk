import { useLocalSearchParams } from 'expo-router';

import { ScriptPage } from '../../src/features/scripts/ScriptPage';

/** One of the family's scripts (docs/PLAN-SCRIPTS.md). */
export default function ScriptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ScriptPage id={id ?? null} />;
}
