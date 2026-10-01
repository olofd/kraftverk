import { useLocalSearchParams } from 'expo-router';

import { AutomationPage } from '../../../src/features/automations/page/AutomationPage';

/** An automation's own page: how it stands, Run, and each part of it in a group. */
export default function AutomationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AutomationPage id={id} />;
}
