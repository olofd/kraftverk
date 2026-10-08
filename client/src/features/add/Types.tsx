import { Button, Text, useTheme, YStack } from 'tamagui';

import type { DeviceTypeListing } from '@kraftverk/api-client';
import { SIMULATED_METHOD_ID } from '@kraftverk/device-sdk';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { HERE } from '../../platform/here';
import { useFamily } from '../../state/FamilyProvider';

const SUPPORT: Record<string, string> = {
  verified: 'Verified on real hardware',
  community: 'Reported working by others',
  experimental: 'Experimental',
};

/**
 * Where a type can run, in words, against where this home is: through your
 * server, from this phone, or both — and, with no server, that a real one
 * needs a server and only its simulator runs here. From its ways: each a
 * node can hold at all, simulated apart.
 */
function whereItRuns(type: Pick<DeviceTypeListing, 'ways'>, role: 'follower' | 'master'): string {
  const real = type.ways.filter((way) => way.fits && way.method !== SIMULATED_METHOD_ID);
  // Without a server, the master is this app's own node.
  const here = real.some((way) => way.holder === (role === 'master' ? 'master' : 'this-node'));
  const server = role === 'follower' && real.some((way) => way.holder === 'master');
  if (role === 'master') return here ? `Works from ${HERE}` : 'Needs a server: here, only its simulator';
  if (here && server) return `Through your server, or from ${HERE}`;
  return server ? 'Through your server' : `From ${HERE} only`;
}

export function Types({ types, onPick, onBack }: { types: DeviceTypeListing[]; onPick: (id: string) => void; onBack: () => void }) {
  const theme = useTheme();
  const { role } = useFamily();
  return (
    <YStack gap="$2">
      <SectionLabel>Which one?</SectionLabel>
      <Card inset>
        {types.length === 0 ? <Row title="Nothing installed matches that" subtitle="Try the brand, or the model printed on it" /> : null}
        {types.map((type, index) => (
          <YStack key={type.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable onPress={() => onPick(type.id)}>
              <Row
                leading={<DeviceImage typeId={type.id} size={40} />}
                title={type.meta.name}
                subtitle={[whereItRuns(type, role), type.meta.description, SUPPORT[type.meta.support], type.meta.models?.length ? `Models: ${type.meta.models.join(', ')}` : null].filter(Boolean).join(' · ')}
                accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </YStack>
        ))}
      </Card>
      <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
        Don’t see yours? Each model is supported by a package of its own, and one can be written for it.
      </Text>
      <Button alignSelf="flex-start" size="$2" onPress={onBack}>
        Back
      </Button>
    </YStack>
  );
}
