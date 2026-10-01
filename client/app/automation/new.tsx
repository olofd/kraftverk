import { useLocalSearchParams } from 'expo-router';

import { EditorScreen } from '../../src/features/automations/editor/EditorScreen';
import { useDevices } from '../../src/state/DevicesProvider';

/** A new automation: from nothing, or from a recipe copied — from the list, or from a device's page. */
export default function NewAutomationScreen() {
  const { device } = useLocalSearchParams<{ device?: string }>();
  const { devices } = useDevices();
  const from = device ? devices.find((candidate) => candidate.id === device) : undefined;
  return <EditorScreen id={null} from={from ? { id: from.id, name: from.name } : null} />;
}
