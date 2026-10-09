import { useLocalSearchParams } from 'expo-router';

import { NewAutomation } from '../../src/features/automations/editor/NewAutomation';

/** A new automation: from nothing, or from a recipe copied — from the list, or from a device's page; or to run a script's step, from the script's. */
export default function NewAutomationScreen() {
  const { device, script, step } = useLocalSearchParams<{ device?: string; script?: string; step?: string }>();
  return <NewAutomation from={device ?? null} running={script && step ? { script, step } : null} />;
}
