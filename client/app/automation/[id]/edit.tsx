import { useLocalSearchParams } from 'expo-router';

import { EditorScreen } from '../../../src/features/automations/editor/EditorScreen';

/** Changing an automation, block by block. */
export default function EditAutomationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EditorScreen id={id} />;
}
