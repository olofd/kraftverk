import { useLocalSearchParams } from 'expo-router';

import { NewAutomation } from '../../src/features/automations/editor/NewAutomation';

/** A new automation: from nothing, or from a recipe copied — from the list, or from a device's page. */
export default function NewAutomationScreen() {
  const { device } = useLocalSearchParams<{ device?: string }>();
  return <NewAutomation from={device ?? null} />;
}
