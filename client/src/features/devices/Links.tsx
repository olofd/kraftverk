import { useState } from 'react';
import { Button, useTheme, YStack } from 'tamagui';

import { describeError, type DeviceView, type LinkView } from '@kraftverk/api-client';
import { linkKindSpec, linkOffers, MAIN_PART, partsOf, type LinkKind, type LinkOffer } from '@kraftverk/device-sdk';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { useDevices } from '../../state/DevicesProvider';
import { capitalise } from './Manage';

/**
 * Facts about the house (docs/ARCHITECTURE.md §4.4), between parts: this
 * plug's relay feeds that station's mains input; this station's AC outlets
 * feed another's. Offered only between parts a link kind fits.
 */
export function Links({ device }: { device: DeviceView }) {
  const { devices, addLink, removeLink } = useDevices();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const theme = useTheme();

  // Decided by the SDK's own rule, the one the home applies: only what it would accept is offered.
  const candidates = linkOffers(
    device.description,
    devices.filter((other) => other.id !== device.id)
  );
  const linked = (candidate: LinkOffer<DeviceView>) =>
    device.links.some(
      (link) => link.kind === candidate.kind && link.role === candidate.role && link.part === candidate.part.id && link.other.id === candidate.other.id && link.other.part === candidate.otherPart.id
    );

  if (device.links.length === 0 && candidates.length === 0) return null;

  const act = async (work: () => Promise<void>) => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  /** "Its AC outlets feed Garage station — Mains", or "Heater plug feeds its mains input". */
  const sentence = (link: { kind: LinkKind; role: 'source' | 'target'; mine: string; other: string }) => {
    const verb = linkKindSpec(link.kind).verb;
    return link.role === 'source' ? `${capitalise(link.mine)} ${verb} ${link.other}` : `${link.other} ${verb} ${link.mine}`;
  };
  const partLabel = (part: string) => (part === MAIN_PART ? 'it' : `its ${(partsOf(device.description).find((candidate) => candidate.id === part)?.label ?? part).toLowerCase()}`);
  const otherName = (name: string, label: string) => (label ? `${name} — ${label}` : name);

  return (
    <YStack gap="$2">
      <SectionLabel>How it fits the house</SectionLabel>
      <Card inset>
        {device.links.map((link: LinkView, index) => (
          <YStack key={link.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Row
              title={sentence({ kind: link.kind, role: link.role, mine: partLabel(link.part), other: otherName(link.other.name, link.other.partLabel) })}
              accessory={
                <Button size="$3" minHeight={44} disabled={busy} onPress={() => void act(() => removeLink(link))}>
                  Remove
                </Button>
              }
            />
          </YStack>
        ))}
        {candidates
          .filter((candidate) => !linked(candidate))
          .map((candidate, index) => (
            <YStack key={`${candidate.kind}-${candidate.role}-${candidate.part.id}-${candidate.other.id}-${candidate.otherPart.id}`}>
              {index > 0 || device.links.length > 0 ? <RowSeparator /> : null}
              <Pressable
                onPress={() => {
                  const mine = { device: device.id, part: candidate.part.id };
                  const theirs = { device: candidate.other.id, part: candidate.otherPart.id };
                  void act(() => addLink({ kind: candidate.kind, source: candidate.role === 'source' ? mine : theirs, target: candidate.role === 'source' ? theirs : mine }));
                }}
              >
                <Row
                  title={sentence({
                    kind: candidate.kind,
                    role: candidate.role,
                    mine: partLabel(candidate.part.id),
                    other: otherName(candidate.other.name, candidate.otherPart.id === MAIN_PART ? '' : candidate.otherPart.label),
                  })}
                  subtitle={linkKindSpec(candidate.kind).description}
                  accessory={<Icon name="plus" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            </YStack>
          ))}
      </Card>
      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
