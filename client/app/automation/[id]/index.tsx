import { useLocalSearchParams } from 'expo-router';

import { AutomationPage } from '../../../src/features/automations/page/AutomationPage';

/** An automation's own page: how it stands, Run, and each part of it in a group. */
export default function AutomationScreen() {
  const { id, edit } = useLocalSearchParams<{ id: string; edit?: string }>();
  // Opened to be edited, as its configuration page asks: through the form, or as YAML.
  return <AutomationPage id={id} edit={edit === 'yaml' || edit === 'form' ? edit : null} />;
}
