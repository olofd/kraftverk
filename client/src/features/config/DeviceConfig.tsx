import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { describeError, deviceYaml, type DeviceView } from '@kraftverk/api-client';
import { Card, haptic, Icon, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { useTone } from '../../components/tone';
import { YamlEditor } from '../../components/YamlEditor';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { ExportOne } from './ExportOne';
import { KeyField } from './KeyField';

/**
 * A device as configuration (docs/CONFIG.md), under its settings: the key a
 * file knows it by, changed in place; what it is and how the home reaches
 * it, as the YAML a file says it in — its secrets by name, never their
 * values — and an export of it alone.
 */
export function DeviceConfig({ device }: { device: DeviceView }) {
  const tone = useTone();
  const { setKey } = useDevices();
  const { api } = useHome();
  const [shown, setShown] = useState<ReturnType<typeof deviceYaml> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const ways = device.connections.filter((connection) => connection.heldBy.kind === 'master');
  const secrets = [...new Set(ways.flatMap((connection) => connection.secrets))];

  const show = async () => {
    haptic();
    if (shown) return setShown(null);
    setProblem(null);
    try {
      setShown(deviceYaml(device, await api.configuration.vocabulary()));
    } catch (err) {
      setProblem(describeError(err) || 'It could not be read');
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Configuration</SectionLabel>
      <Card inset>
        <KeyField value={device.key} label="Name in configuration" help="What a configuration file calls it, and what an import matches it by." onSave={(key) => setKey(device.id, key)} />
        <RowSeparator />
        <YStack padding="$4" paddingTop="$3" gap="$3">
          <XStack gap="$2" flexWrap="wrap">
            <Button size="$3" minHeight={44} icon={<Icon name={shown ? 'eye-off' : 'eye'} size={16} color={tone('$color')} />} onPress={() => void show()}>
              {shown ? 'Hide its configuration' : 'Show as configuration'}
            </Button>
            <Button size="$3" minHeight={44} icon={<Icon name="download" size={16} color={tone('$color')} />} onPress={() => (haptic(), setExporting((was) => !was))}>
              Export
            </Button>
          </XStack>
          {exporting ? <ExportOne what={{ devices: [device.key] }} name={device.name} secrets={secrets} plainAllowed={ways.some((connection) => connection.secretsExportable && connection.secrets.length > 0)} /> : null}
          {problem ? (
            <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
              {problem}
            </Text>
          ) : null}
          {shown ? (
            <>
              <YamlEditor value={shown.text} label={`${device.name}, as configuration`} minLines={4} />
              {shown.secrets || shown.heldElsewhere ? (
                <Text fontSize={12} color="$muted" lineHeight={17}>
                  {[
                    shown.secrets ? 'Its secrets by name only: their values stay on the server, and an export leaves them out, seals them, or carries them in plain text where allowed.' : null,
                    shown.heldElsewhere ? `${shown.heldElsewhere === 1 ? 'A way an app holds is' : `${shown.heldElsewhere} ways apps hold are`} not in it: its keys live on the phone.` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </Text>
              ) : null}
            </>
          ) : null}
        </YStack>
      </Card>
    </YStack>
  );
}
