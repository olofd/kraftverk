import { useState } from 'react';
import { Button, XStack, YStack } from 'tamagui';

import { automationYaml } from '@kraftverk/api-client/config';
import { changeAutomation, describeError, type AutomationView } from '@kraftverk/api-client';
import { haptic, Icon, RowSeparator } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useTone } from '../../components/tone';
import { YamlEditor } from '../../components/YamlEditor';
import { useFamily } from '../../state/FamilyProvider';
import { Group } from '../automations/page/Group';
import { ExportOne } from './ExportOne';
import { KeyField } from './KeyField';
import { useWorldKeys } from './useWorldKeys';

/**
 * An automation as configuration (docs/CONFIG.md), on its page: the key a
 * file knows it by, changed in place; what it is, as the YAML a file says it
 * in — to read, and to learn the language from what you built — and a way to
 * write it so instead of through the form; and an export of it alone.
 */
export function AutomationConfig({ automation, onChanged, onEditYaml }: { automation: AutomationView; onChanged: (next: AutomationView) => void; onEditYaml: () => void }) {
  const { api } = useFamily();
  const tone = useTone();
  const [shown, setShown] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const world = useWorldKeys();

  const show = async () => {
    haptic();
    if (shown !== null) return setShown(null);
    setProblem(null);
    try {
      // The devices that fill its roles and the automations it starts, by their keys: read now, so none is missed while the app's own list is still coming.
      const [devices, others] = await Promise.all([api.devices.list(), Object.keys(automation.starts).length ? api.automations.list() : Promise.resolve([])]);
      setShown(automationYaml({ ...automation, madeFrom: automation.madeFrom?.id ?? null }, devices, others, [], world));
    } catch (err) {
      setProblem(describeError(err) || 'It could not be read');
    }
  };

  return (
    <Group icon="code" title="Configuration" summary={automation.key} inset>
      <KeyField
        value={automation.key}
        label="Name in configuration"
        help="What a configuration file calls it, and what an import matches it by."
        onSave={async (key) => {
          const answer = await changeAutomation(api, automation.id, { key });
          if ('automation' in answer) onChanged(answer.automation);
        }}
      />
      <RowSeparator />
      <YStack padding="$4" paddingTop="$1" gap="$3">
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" minHeight={44} icon={<Icon name={shown !== null ? 'eye-off' : 'eye'} size={16} color={tone('$color')} />} onPress={() => void show()}>
            {shown !== null ? 'Hide its configuration' : 'Show as configuration'}
          </Button>
          <Button
            size="$3"
            minHeight={44}
            icon={<Icon name="edit-3" size={16} color={tone('$color')} />}
            disabled={automation.running !== null}
            opacity={automation.running ? 0.5 : 1}
            onPress={() => (haptic(), onEditYaml())}
          >
            Edit as YAML
          </Button>
          <Button size="$3" minHeight={44} icon={<Icon name="download" size={16} color={tone('$color')} />} onPress={() => (haptic(), setExporting((was) => !was))}>
            Export
          </Button>
        </XStack>
        {exporting ? <ExportOne what={{ automations: [automation.key] }} name={automation.name} /> : null}
        {problem ? (
          <ErrorText>
            {problem}
          </ErrorText>
        ) : null}
        {shown !== null ? <YamlEditor value={shown} label={`${automation.name}, as configuration`} /> : null}
      </YStack>
    </Group>
  );
}
