import { useCallback, useEffect, useMemo, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, useTheme, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import type { AddableType, SupportLevel } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';

import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { featherName } from '../src/lib/icons';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * Adding a device.
 *
 * The list of what can be added comes from the server, which finds every
 * device type installed on it (docs/ARCHITECTURE.md §3). So a device type added
 * next year appears here without this screen changing — the whole point, and
 * the thing that would be quietly untrue if this file contained a list of its
 * own. Each says how far it is trusted, in its own words.
 */

/** How far a type is trusted, in a few words. */
const SUPPORT: Record<SupportLevel, string> = {
  verified: 'Verified',
  community: 'Community',
  experimental: 'Experimental',
};

export default function AddDeviceScreen() {
  const { types, add } = useDevices();

  const [options, setOptions] = useState<AddableType[] | null>(null);
  const [chosen, setChosen] = useState<AddableType | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void types()
      .then((loaded) => live && setOptions(loaded))
      .catch((err: unknown) => {
        if (live) setError(describeError(err) || 'Could not load what can be added');
      });
    return () => {
      live = false;
    };
  }, [types]);

  const choose = useCallback((option: AddableType) => {
    haptic();
    setChosen(option);
    setName(option.meta.name);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const created = await add({ typeId: chosen.id, name: name.trim() || chosen.meta.name });
      router.replace(`/device/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(describeError(err) || 'That device could not be added');
      setBusy(false);
    }
  }, [add, chosen, name]);

  const hardware = useMemo(() => options?.filter((option) => option.kind === 'hardware') ?? [], [options]);
  const services = useMemo(() => options?.filter((option) => option.kind === 'service') ?? [], [options]);

  return (
    <Screen back="Your devices" title="Add a device" subtitle="What have you got?">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      {options === null ? (
        <Card>
          <YStack padding="$5" alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        </Card>
      ) : (
        <>
          <Choices label="Devices" options={hardware} chosen={chosen} onChoose={choose} />
          {services.length ? <Choices label="Services" options={services} chosen={chosen} onChoose={choose} /> : null}
        </>
      )}

      {/*
        In-app Bluetooth — the app holding a station itself — is frozen
        (docs/ARCHITECTURE.md §9), so it is offered beside the types that can use it.
      */}
      {chosen?.protocols.includes('sydpower') ? <ConnectionOwner /> : null}

      {chosen ? (
        <>
          <YStack gap="$2">
            <SectionLabel>Name</SectionLabel>
            <Card gap="$2">
              <Input
                size="$3"
                value={name}
                maxLength={60}
                placeholder={chosen.meta.name}
                onChangeText={setName}
                backgroundColor="$background"
                borderColor="$borderColor"
              />
              <Text fontSize={12} color="$muted" lineHeight={17}>
                What you call it. Changing it later changes nothing but the label.
              </Text>
            </Card>
          </YStack>

          <Button
            size="$4"
            backgroundColor="$accent"
            color="$background"
            disabled={busy}
            onPress={() => {
              haptic();
              void submit();
            }}
          >
            {busy ? 'Adding…' : `Add ${name.trim() || chosen.meta.name}`}
          </Button>

          {chosen.extension ? (
            <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
              How this reaches the device — its address and keys — is set up on the Extensions
              screen for now. Until that is done it will sit here greyed out, saying why.
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/** One section of things that can be added. */
function Choices({
  label,
  options,
  chosen,
  onChoose,
}: {
  label: string;
  options: AddableType[];
  chosen: AddableType | null;
  onChoose: (option: AddableType) => void;
}) {
  const theme = useTheme();

  return (
    <YStack gap="$2">
      <SectionLabel>{label}</SectionLabel>
      <Card inset>
        {options.length === 0 ? (
          <Text fontSize={13} color="$muted" padding="$4">
            Nothing of this kind is installed on the server.
          </Text>
        ) : null}
        {options.map((option, index) => {
          const active = chosen?.id === option.id;
          const support = [SUPPORT[option.meta.support], option.meta.supportNote].filter(Boolean).join(' · ');

          return (
            <YStack key={option.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable selected={active} label={option.meta.name} onPress={() => onChoose(option)}>
                <Row
                  title={option.meta.name}
                  subtitle={[option.meta.description, support].filter(Boolean).join('\n')}
                  accessory={
                    <Feather
                      name={active ? 'check-circle' : featherName(option.meta.icon)}
                      size={16}
                      color={active ? theme.accent?.val : theme.muted?.val}
                    />
                  }
                />
              </Pressable>
            </YStack>
          );
        })}
      </Card>
    </YStack>
  );
}

/**
 * Who will hold the link — and the honest admission that this screen only makes
 * one of the two.
 *
 * Adding a device here creates a **server-owned** station: the server holds the
 * link, which is what makes history, background sampling and automations
 * possible, because only the server is running when the app is closed.
 *
 * Driving a station straight from this browser or phone over Bluetooth is a
 * different kind of connection, and it does not need a saved device at all. It
 * is set up on the Station link screen. Saying so here is the difference between
 * a user who finds that screen and one who adds a station the server cannot
 * reach and is left with a permanently grey card.
 *
 * A device type's setup guide will offer both in one flow; until then, this
 * points at the screen that already works rather than pretending.
 */
function ConnectionOwner() {
  const theme = useTheme();

  return (
    <YStack gap="$2">
      <SectionLabel>Connection</SectionLabel>
      <Card gap="$3" alignItems="flex-start">
        <Text fontSize={13} color="$muted" lineHeight={19}>
          The <Text color="$color">server</Text> will hold this station's link, over WiFi or its
          own Bluetooth. That is what records history and can run automations while the app is
          closed.
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          To drive a station from <Text color="$color">this device</Text> over Bluetooth instead —
          live readings, settings and manual control while the app is open — you do not add it
          here. Set that up on the Station link screen.
        </Text>
        <Button
          size="$3"
          icon={<Feather name="bluetooth" size={14} color={theme.color?.val} />}
          onPress={() => {
            haptic();
            router.push('/link?connection=direct');
          }}
        >
          Connect over Bluetooth instead
        </Button>
      </Card>
    </YStack>
  );
}
