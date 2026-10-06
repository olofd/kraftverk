import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { SetupStepView } from '@kraftverk/device-sdk';
import { describeError, type SightingView } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useAttempt } from '../../../components/useAttempt';
import { ErrorLine, PRIMARY, StepFrame, type StepProps } from './StepFrame';

/** How often what can be seen is read again, while a device is being chosen. */
const SEEN_AGAIN_MS = 2000;

export function ChooseStep({
  flow,
  step,
  onNext,
  onBack,
  presetAddress,
  presetThrough,
}: StepProps & { step: Extract<SetupStepView, { kind: 'choose' }>; presetAddress?: string; presetThrough?: string }) {
  const [sightings, setSightings] = useState<SightingView[]>([]);
  const [manual, setManual] = useState('');
  const { busy, error, setError: setError, attempt } = useAttempt();
  const theme = useTheme();

  // Through a bridge: its members, from the bridge's own list — never typed, never a chooser.
  const behind = step.transport === 'bridge';
  const pick = useCallback(
    async (choice: { address: string; through?: string } | { manual: string }) => {
      await attempt(async () => {
        await flow.choose(choice);
        onNext();
      }, 'That did not work');
    },
    [flow, onNext]
  );

  // A live list: what the transport sees, kept current while this step is open.
  useEffect(() => {
    if (step.discovery !== 'list') return;
    let live = true;
    const load = () =>
      flow
        .sightings()
        .then((next) => live && setSightings(next))
        .catch((err: unknown) => live && setError(describeError(err)));
    void load();
    const timer = setInterval(() => void load(), SEEN_AGAIN_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [flow, step.discovery]);

  // Found near you: that one, once the list has it — behind the bridge it was found behind.
  useEffect(() => {
    if (!presetAddress || busy || flow.address) return;
    const found = sightings.find((sighting) => sighting.address === presetAddress && (!presetThrough || sighting.through?.id === presetThrough));
    if (found) void pick({ address: found.address, ...(found.through ? { through: found.through.id } : {}) });
  }, [busy, flow.address, pick, presetAddress, presetThrough, sightings]);

  const openChooser = (showAll: boolean) => {
    haptic();
    setError(null);
    // Straight from the tap: the browser refuses a chooser that was awaited first.
    flow
      .chooser(showAll)
      .then((sighting) => (sighting ? pick({ address: sighting.address }) : undefined))
      .catch((err: unknown) => setError(describeError(err) || 'The chooser could not open'));
  };

  return (
    <StepFrame
      title={step.title}
      description={flow.address ? undefined : behind ? 'The devices behind it that could be this one. Choose yours.' : step.discovery === 'list' ? 'Devices on your network that could be it. Choose yours.' : undefined}
      onBack={onBack}
      next={flow.address ? { label: `Use ${flow.address}`, onPress: onNext } : undefined}
    >
      {flow.address ? (
        <Card gap="$2">
          <Text fontSize={14} color="$color" lineHeight={20}>
            It is at {flow.address}. Choose another below if that is not the one.
          </Text>
        </Card>
      ) : null}
      {step.discovery === 'chooser' ? (
        <Card gap="$3">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Your browser shows its own list of nearby devices. Pick yours there.
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            <Button size="$3" {...PRIMARY} disabled={busy} icon={<Icon name="bluetooth" size={14} color={theme.background?.val} />} onPress={() => openChooser(false)}>
              Choose your device
            </Button>
            <Button size="$3" disabled={busy} onPress={() => openChooser(true)}>
              Show every device
            </Button>
          </XStack>
        </Card>
      ) : null}
      {step.discovery === 'list' ? (
        <Card inset>
          {sightings.length === 0 ? (
            <XStack padding="$4" gap="$3" alignItems="center">
              <Spinner color="$accent" />
              <Text flex={1} fontSize={13} color="$muted" lineHeight={19}>
                {behind
                  ? 'Asking what is behind it… Nothing yet: is it on the account, or paired with the gateway?'
                  : 'Looking… It appears here as soon as it can be seen. A device already connected to something else may stay quiet: type its address below.'}
              </Text>
            </XStack>
          ) : (
            sightings.map((sighting, index) => (
              <YStack key={`${sighting.through?.id ?? ''}-${sighting.address}`}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable disabled={busy || sighting.claimedBy !== null} onPress={() => void pick({ address: sighting.address, ...(sighting.through ? { through: sighting.through.id } : {}) })}>
                  <Row
                    title={sighting.name}
                    subtitle={sighting.claimedBy ? `Already yours: ${sighting.claimedBy.name}` : (sighting.detail ?? sighting.address)}
                    disabled={sighting.claimedBy !== null}
                    accessory={<Icon name={sighting.claimedBy ? 'check' : 'chevron-right'} size={16} color={theme.muted?.val} />}
                  />
                </Pressable>
              </YStack>
            ))
          )}
        </Card>
      ) : null}
      {step.manual ? (
        <Card gap="$2">
          <Text fontSize={13} color="$muted">
            Or type its {step.manual.toLowerCase()}
          </Text>
          <XStack gap="$2">
            <Input
              flex={1}
              size="$3"
              value={manual}
              onChangeText={setManual}
              placeholder={step.manual}
              aria-label={step.manual}
              autoCapitalize="none"
              backgroundColor="$background"
              borderColor="$borderColor"
              onSubmitEditing={() => (manual.trim() ? void pick({ manual }) : undefined)}
            />
            <Button size="$3" disabled={busy || !manual.trim()} onPress={() => void pick({ manual })}>
              Use it
            </Button>
          </XStack>
        </Card>
      ) : null}
      <ErrorLine message={error} />
    </StepFrame>
  );
}
