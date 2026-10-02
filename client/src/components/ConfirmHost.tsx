import { useEffect, useRef, useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { setConfirmHost, type ConfirmRequest } from '../platform/confirm';
import { useDialogFocus } from '../lib/useDialogFocus';

/**
 * Where the app asks a person to confirm something, on the web: drawn by the
 * app, not by the browser.
 *
 * `window.confirm` was the honest equivalent of a phone's alert until it was
 * not: an embedded browser, or one where someone ticked "prevent this page
 * from creating additional dialogs", answers no at once and shows nothing. So
 * arming an automation, cutting a loaded plug or resetting a counter did
 * nothing at all, and said nothing.
 *
 * Mounted once, inside the app's theme — a React Native `Modal` is drawn
 * outside it on the web, in the browser's own font — and fixed over the page.
 * One question at a time, in the order they came. Escape says no; the
 * keyboard stays inside it while it is open, and starts on its yes.
 */
export function ConfirmHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const yesRef = useRef<HTMLElement | null>(null);
  const boxRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setConfirmHost((request) => setQueue((current) => [...current, request]));
    return () => setConfirmHost(null);
  }, []);

  const asked = queue[0];
  const answer = (yes: boolean) => {
    if (!asked) return;
    asked.resolve(yes);
    setQueue((current) => current.slice(1));
  };

  // Starts on its yes, round and round its two buttons, Escape says no, and back to what was pressed after.
  useDialogFocus(asked !== undefined, boxRef, () => answer(false), { start: yesRef, key: asked });

  if (!asked) return null;
  return (
    <YStack
      style={{ position: 'fixed' } as never}
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={1000}
      alignItems="center"
      justifyContent="center"
      padding="$4"
      backgroundColor="rgba(8,12,20,0.6)"
      onPress={() => answer(false)}
    >
      <YStack
        ref={boxRef as never}
        role="alertdialog"
        aria-modal
        aria-label={asked.title}
        width="100%"
        maxWidth={440}
        gap="$3"
        padding="$5"
        borderRadius="$6"
        borderWidth={1}
        borderColor="$borderColor"
        backgroundColor="$card"
        shadowColor="rgba(0,0,0,0.35)"
        shadowRadius={32}
        shadowOffset={{ width: 0, height: 12 }}
        // A press inside is not a press on the backdrop.
        onPress={(event: { stopPropagation?: () => void }) => event.stopPropagation?.()}
      >
        <Text fontSize={18} fontWeight="800" color="$color" lineHeight={24}>
          {asked.title}
        </Text>
        {asked.message.split('\n\n').map((paragraph, index) => (
          <Text key={index} fontSize={14} color={index === 0 ? '$color' : '$muted'} lineHeight={21}>
            {paragraph}
          </Text>
        ))}
        <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap" marginTop="$2">
          <Button size="$4" chromeless onPress={() => answer(false)}>
            Cancel
          </Button>
          <Button
            ref={yesRef as never}
            size="$4"
            backgroundColor={asked.tone === 'dangerous' ? '$danger' : '$accent'}
            color={asked.tone === 'dangerous' ? '$white' : '$background'}
            fontWeight="700"
            pressStyle={{ opacity: 0.85 }}
            onPress={() => answer(true)}
          >
            {asked.confirmLabel}
          </Button>
        </XStack>
      </YStack>
    </YStack>
  );
}
