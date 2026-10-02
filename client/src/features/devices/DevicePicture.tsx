import { useRef, useState, type ReactNode } from 'react';
import { Image, Modal, Platform } from 'react-native';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceView, PictureRef } from '@kraftverk/api-client';
import { haptic, Icon } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { ErrorText } from '../../components/ErrorText';
import { useDialogFocus } from '../../components/useDialogFocus';
import { useDevices } from '../../state/DevicesProvider';
import { picturesOf } from './registry';

const SIZE = 104;

/** Enter or Space presses what a keyboard is on, as they press a button: a stack given a role is not given its keys. */
const pressedBy = (press: () => void) => (event: { key: string; preventDefault: () => void }) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  press();
};

/**
 * A device's picture on its own page — and, where its type ships more than
 * one, the way to pick which: tap it, and every picture is offered, the one
 * shown marked. The choice is the device's, kept by the server (or this app,
 * with none), so every screen shows the same.
 */
export function DevicePicture({ device }: { device: DeviceView }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const pictures = picturesOf(device.typeId);
  if (!pictures.length) return null;
  const shown = <DeviceImage typeId={device.typeId} picture={device.picture} size={SIZE} />;
  if (pictures.length < 2 || device.removedAt) return shown;

  return (
    <>
      <YStack
        role="button"
        position="relative"
        tabIndex={0}
        aria-label={`Change the picture of ${device.name}`}
        cursor="pointer"
        borderRadius="$4"
        hoverStyle={{ backgroundColor: '$backgroundHover' }}
        pressStyle={{ opacity: 0.8 }}
        focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
        onPress={() => (haptic(), setOpen(true))}
        onKeyDown={pressedBy(() => setOpen(true)) as never}
      >
        {shown}
        {/* A small mark says it can be changed, without taking over the picture. */}
        <XStack position="absolute" right={2} bottom={2} width={26} height={26} borderRadius={13} alignItems="center" justifyContent="center" backgroundColor="$card" borderWidth={1} borderColor="$borderColor">
          <Icon name="image" size={13} color={theme.muted?.val} />
        </XStack>
      </YStack>
      {open ? <PicturePicker device={device} count={pictures.length} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Every picture of its type, large, the one shown marked: a tap shows another, at once. */
function PicturePicker({ device, count, onClose }: { device: DeviceView; count: number; onClose: () => void }) {
  const theme = useTheme();
  const { setPicture } = useDevices();
  const [saving, setSaving] = useState<PictureRef | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const boxRef = useRef<HTMLElement | null>(null);

  // As any dialog: the keyboard starts inside it and stays there, Escape closes it, and focus goes back to the picture.
  useDialogFocus(true, boxRef, onClose);

  const choose = async (picture: PictureRef) => {
    if (picture === device.picture) return onClose();
    haptic();
    setSaving(picture);
    setProblem(null);
    try {
      await setPicture(device.id, picture);
      onClose();
    } catch {
      setProblem('It could not be changed. Try again.');
      setSaving(null);
    }
  };

  const content = (
    <YStack flex={1} alignItems="center" justifyContent="center" padding="$4" backgroundColor="rgba(8,12,20,0.6)" onPress={onClose}>
      <YStack
        ref={boxRef as never}
        role="dialog"
        aria-modal
        aria-label={`The picture of ${device.name}`}
        width="100%"
        maxWidth={560}
        gap="$4"
        padding="$5"
        borderRadius="$6"
        borderWidth={1}
        borderColor="$borderColor"
        backgroundColor="$card"
        onPress={(event: { stopPropagation?: () => void }) => event.stopPropagation?.()}
      >
        <XStack alignItems="flex-start" justifyContent="space-between" gap="$3">
          <YStack flex={1} gap={2}>
            <Text fontSize={18} fontWeight="800" color="$color">
              Its picture
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Shown on its page and in your list of devices.
            </Text>
          </YStack>
          <Button size="$3" circular chromeless aria-label="Close" icon={<Icon name="x" size={18} color={theme.muted?.val} />} onPress={onClose} />
        </XStack>

        <XStack gap="$3" flexWrap="wrap" role="radiogroup" aria-label="Pictures">
          {Array.from({ length: count }, (_, picture) => (
            <Choice key={picture} selected={`type:${picture}` === device.picture} busy={saving === `type:${picture}`} onPress={() => void choose(`type:${picture}`)} label={`Picture ${picture + 1}`}>
              <Image source={picturesOf(device.typeId)[picture]!} resizeMode="contain" style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
            </Choice>
          ))}
        </XStack>

        {problem ? (
          <ErrorText>
            {problem}
          </ErrorText>
        ) : null}
      </YStack>
    </YStack>
  );

  // Fixed over the page on the web, inside the app's theme; a modal on a phone.
  if (Platform.OS === 'web') {
    return (
      <YStack style={{ position: 'fixed' } as never} top={0} left={0} right={0} bottom={0} zIndex={900}>
        {content}
      </YStack>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

/** One picture to pick: a tile, marked when it is the one shown. */
function Choice({ selected, busy, label, onPress, children }: { selected: boolean; busy: boolean; label: string; onPress: () => void; children: ReactNode }) {
  const theme = useTheme();
  return (
    <YStack
      role="radio"
      position="relative"
      aria-checked={selected}
      aria-label={label}
      tabIndex={0}
      width={150}
      height={120}
      padding="$2"
      borderRadius="$5"
      borderWidth={2}
      borderColor={selected ? '$accent' : '$borderColor'}
      backgroundColor={selected ? '$backgroundPress' : '$background'}
      cursor="pointer"
      hoverStyle={{ borderColor: '$accent' }}
      pressStyle={{ scale: 0.97 }}
      focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
      onPress={onPress}
      onKeyDown={pressedBy(onPress) as never}
    >
      {children}
      {selected || busy ? (
        <XStack position="absolute" top={6} right={6} width={22} height={22} borderRadius={11} alignItems="center" justifyContent="center" backgroundColor="$accent">
          {busy ? <Spinner size="small" color="$background" /> : <Icon name="check" size={13} color={theme.background?.val} />}
        </XStack>
      ) : null}
    </YStack>
  );
}
