import { useState } from 'react';
import { router } from 'expo-router';
import { useTheme, XStack, YStack } from 'tamagui';

import { CATEGORIES } from '@kraftverk/device-sdk';
import { type DeviceTypeListing, PATHS } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { featherName } from '../../components/icons';
import { Pressable } from '../../components/Pressable';

type Shelf = 'devices' | 'services';
type Section = Shelf | 'empty';

const SECTION_LABELS: Record<Section, string> = { devices: 'Devices', services: 'Services', empty: 'Nothing installed yet' };

/** The categories of one shelf — devices, or services — with what is installed on each; `types` are that shelf's. */
export function Categories({ types, shelf, onPick }: { types: DeviceTypeListing[]; shelf: Shelf; onPick: (id: string) => void }) {
  const theme = useTheme();
  // The shelves nothing is installed on are many, and say only that: folded away until asked.
  const [showEmpty, setShowEmpty] = useState(false);
  // Each category says its shelf: this one's, with something installed on it, then those with nothing yet.
  const mine = Object.entries(CATEGORIES).filter(([, spec]) => spec.shelf === shelf);
  const installedOn = (id: string) => types.some((type) => type.meta.category === id);
  const sections = [
    { section: shelf as Section, categories: mine.filter(([id]) => installedOn(id)) },
    { section: 'empty' as Section, categories: mine.filter(([id]) => !installedOn(id)) },
  ].filter(({ categories }) => categories.length > 0);
  return (
    <>
      {sections.map(({ section, categories }) => (
        <YStack key={section} gap="$2">
          <SectionLabel>{SECTION_LABELS[section]}</SectionLabel>
          <Card inset>
            {section === 'empty' ? (
              <Pressable onPress={() => setShowEmpty((shown) => !shown)}>
                <Row
                  title={categories.length === 1 ? 'One more kind of thing' : `${categories.length} more kinds of thing`}
                  subtitle={showEmpty ? 'No package for these is installed' : categories.map(([, spec]) => spec.label).join(', ')}
                  accessory={<Icon name={showEmpty ? 'chevron-up' : 'chevron-down'} size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            ) : null}
            {(section !== 'empty' || showEmpty ? categories : []).map(([id, spec], index) => {
              const installed = types.filter((type) => type.meta.category === id);
              const count = installed.length;
              return (
                <YStack key={id}>
                  {index > 0 || section === 'empty' ? <RowSeparator /> : null}
                  <Pressable disabled={count === 0} onPress={() => onPick(id)}>
                    <XStack alignItems="center" gap="$3" paddingLeft="$4">
                      <Icon name={featherName(spec.icon)} size={18} color={count ? theme.accent?.val : theme.muted?.val} />
                      <YStack flex={1}>
                        <Row title={spec.label} subtitle={count ? installed.map((type) => type.meta.name).join(', ') : 'No package for these is installed'} disabled={count === 0} />
                      </YStack>
                    </XStack>
                  </Pressable>
                </YStack>
              );
            })}
          </Card>
        </YStack>
      ))}
      <YStack gap="$2">
        <SectionLabel>Already described</SectionLabel>
        <Card inset>
          <Pressable onPress={() => router.push(PATHS.settings.configuration({ import: true }))}>
            <XStack alignItems="center" gap="$3" paddingLeft="$4">
              <Icon name="file-text" size={18} color={theme.accent?.val} />
              <YStack flex={1}>
                <Row title="From a configuration" subtitle="A device exported from here or another kraftverk, or written by hand: pasted, or opened as a file" />
              </YStack>
            </XStack>
          </Pressable>
        </Card>
      </YStack>
    </>
  );
}
