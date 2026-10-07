import { useState } from 'react';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { describeError, SetupFlow, type CheckOutcome, type DeviceView, type SaveInput } from '@kraftverk/api-client';
import { LINK_KIND_IDS, linkableParts, linkKindSpec, linkOffers, MAIN_PART, partName, type DeviceDescription } from '@kraftverk/device-sdk';
import { Card, haptic, Row, RowSeparator, SectionLabel, ToggleRow } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { MovePlan } from './MovePlan';
import { Pressable } from '../../components/Pressable';
import { secretWords } from '../../components/ProblemList';
import { confirmAction } from '../../platform/confirm';
import { HERE } from '../../platform/here';
import { useHome } from '../../state/HomeProvider';

export function Finish({
  flow,
  outcome,
  onBack,
  typeName,
  description,
  attachTo,
  devices,
  onSaved,
}: {
  flow: SetupFlow;
  outcome: CheckOutcome;
  onBack: () => void;
  /** The name offered: what its maker's app calls it, when a helper learnt that, else its model. */
  typeName: string;
  /** What it is, as its type describes it: which links fit is decided the way the server decides it. */
  description: DeviceDescription;
  attachTo: DeviceView | null;
  devices: DeviceView[];
  onSaved: (id: string) => Promise<void>;
}) {
  // A device you have, moved to this type: its own name kept, unless changed.
  const move = outcome.outcome === 'yours' && !attachTo ? outcome.move : null;
  const [name, setName] = useState(move ? move.device.name : typeName);
  const [restore, setRestore] = useState<string | null>(outcome.outcome === 'removed' ? (outcome.devices[0]?.id ?? null) : null);
  /** By question, the other end chosen: "device|part", or empty for none. */
  const [links, setLinks] = useState<Record<string, string>>({});
  /** Whether the secrets just given may leave in an export as plain text: off unless chosen, and warned against (docs/CONFIG.md). */
  const [exportable, setExportable] = useState(false);
  const keepsSecrets = flow.holder === 'master' && flow.secrets.length > 0;
  const { role: nodeRole } = useHome();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Questions a link kind asks, one per part of this device that fits one end, with the parts of devices you have that fit the other: the SDK's offers, grouped.
  const offers = linkOffers(description, devices);
  const questions = LINK_KIND_IDS.flatMap((kind) =>
    (['source', 'target'] as const).flatMap((role) =>
      linkableParts(kind, description, role).flatMap((part) => {
        const options = offers
          .filter((offer) => offer.kind === kind && offer.role === role && offer.part.id === part.id)
          .map(({ other, otherPart }) => ({ value: `${other.id}|${otherPart.id}`, title: partName(other.name, otherPart.id, otherPart.label), subtitle: other.meta.name }));
        const spec = linkKindSpec(kind);
        const question = role === 'source' ? spec.question.fromSide : spec.question.toSide;
        return options.length ? [{ key: `${kind}:${role}:${part.id}`, kind, role, part: part.id, question: part.id === MAIN_PART ? question : `${part.label}: ${question}`, options }] : [];
      })
    )
  );

  const save = async () => {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const input: SaveInput = attachTo
        ? { name: '', mode: 'attach', deviceId: attachTo.id }
        : move
          ? { name, mode: 'move', deviceId: move.device.id }
          : restore
          ? { name, mode: 'restore', deviceId: restore }
          : {
              name,
              mode: 'new',
              anyway: outcome.outcome === 'no-answer' ? true : undefined,
              links: questions.flatMap((question) => {
                const chosen = links[question.key];
                if (!chosen) return [];
                const [device, part] = chosen.split('|') as [string, string];
                return [{ kind: question.kind, part: question.part, other: { device, part }, role: question.role }];
              }),
            };
      if (attachTo && outcome.outcome === 'no-answer') input.anyway = true;
      if (keepsSecrets && exportable) input.secretsExportable = true;
      await onSaved(await flow.save(input));
    } catch (err) {
      setError(describeError(err) || 'It could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3">
      {move ? <MovePlan move={move} /> : null}

      {outcome.outcome === 'removed' && !attachTo ? (
        <YStack gap="$2">
          <SectionLabel>Bring it back?</SectionLabel>
          <Card inset>
            {outcome.devices.map((device, index) => (
              <YStack key={device.id}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable selected={restore === device.id} onPress={() => setRestore(device.id)}>
                  <Row title={`Bring back ${device.name}, with its history`} subtitle={`Removed ${new Date(device.removedAt).toLocaleDateString()}`} />
                </Pressable>
              </YStack>
            ))}
            <RowSeparator />
            <Pressable selected={restore === null} onPress={() => setRestore(null)}>
              <Row title="Start fresh" subtitle="A new device; the old one stays removed, with its history" />
            </Pressable>
          </Card>
        </YStack>
      ) : null}

      {attachTo ? null : (
        <YStack gap="$2">
          <SectionLabel>Name it</SectionLabel>
          <Card gap="$2">
            <Input size="$3" value={name} maxLength={60} onChangeText={setName} onSubmitEditing={() => (!busy && name.trim() ? void save() : undefined)} backgroundColor="$background" borderColor="$borderColor" aria-label="Its name" />
            <Text fontSize={12} color="$muted">
              {flow.holder === 'master' && nodeRole === 'follower' ? 'Held by your server.' : `Held by ${HERE}.`}
            </Text>
          </Card>
        </YStack>
      )}

      {!attachTo && !restore && !move
        ? questions.map((question) => (
            <YStack key={question.key} gap="$2">
              <SectionLabel>{question.question}</SectionLabel>
              <Card inset>
                <Pressable selected={!links[question.key]} onPress={() => setLinks((before) => ({ ...before, [question.key]: '' }))}>
                  <Row title="None of these" />
                </Pressable>
                {question.options.map((option) => (
                  <YStack key={option.value}>
                    <RowSeparator />
                    <Pressable selected={links[question.key] === option.value} onPress={() => setLinks((before) => ({ ...before, [question.key]: option.value }))}>
                      <Row title={option.title} subtitle={option.subtitle} />
                    </Pressable>
                  </YStack>
                ))}
              </Card>
            </YStack>
          ))
        : null}

      {keepsSecrets ? (
        <YStack gap="$2">
          <SectionLabel>Its {secretWords(flow.secrets)}</SectionLabel>
          <Card inset>
            <ToggleRow
              title="May leave in plain text"
              subtitle={
                exportable
                  ? 'An export that asks for plain text carries it as it is: anyone with the file can reach the device as you do.'
                  : 'Off: an export leaves it out, or seals it with a passphrase you choose. Kept safely by your home either way.'
              }
              checked={exportable}
              onCheckedChange={(on) =>
                void (async () => {
                  if (
                    on &&
                    !(await confirmAction(
                      'Let it leave in plain text?',
                      `An export that asks for plain text will carry its ${secretWords(flow.secrets)} as it is. Anyone who has the file — a backup, a mail, a shared folder — can then reach the device as you do.\n\nAn export sealed with a passphrase carries it safely without this. You can change this later, under its settings.`,
                      'Let it leave',
                      'dangerous'
                    ))
                  )
                    return;
                  setExportable(on);
                })()
              }
            />
          </Card>
        </YStack>
      ) : null}

      <XStack justifyContent="space-between" alignItems="center">
        <Button size="$3" chromeless color="$muted" onPress={onBack}>
          Back
        </Button>
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || (!attachTo && !name.trim())} onPress={() => void save()}>
          {busy ? 'Saving…' : attachTo ? `Add it to ${attachTo.name}` : move ? `Move ${move.device.name}` : restore ? 'Bring it back' : 'Save'}
        </Button>
      </XStack>
      {error ? (
        <ErrorText fontSize={12}>
          {error}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
