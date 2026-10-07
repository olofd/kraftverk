import { useLocalSearchParams } from 'expo-router';

import { AutomationPage } from '../../../src/features/automations/page/AutomationPage';

/** An automation, being changed: through its form, or as its YAML (`?view=yaml`). */
export default function EditAutomationScreen() {
  const { id, view } = useLocalSearchParams<{ id: string; view?: string }>();
  return <AutomationPage id={id} edit={view === 'yaml' ? 'yaml' : 'form'} />;
}
