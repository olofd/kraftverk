import type { ReactNode } from 'react';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import { Icon, type IconName } from '@kraftverk/ui';

/**
 * One part of an automation, in a box of its own (docs/AUTOMATIONS-UX.md):
 * a header — its mark, its name, a word on what is in it — and what belongs
 * to it, inside. What starts it, what it must meet, what it does, what it does
 * if a step fails: each a group, so what belongs to what is never in doubt.
 * An empty group says so inside its box. Its name is a heading, so a screen
 * reader can jump from group to group.
 */
export function Group({ icon, title, summary, inset, children }: { icon: IconName; title: string; summary?: string; inset?: boolean; children: ReactNode }) {
  const theme = useTheme();
  const accent = theme.accent?.val as string;
  return (
    <YStack role="region" aria-label={title} borderWidth={1} borderColor="$borderColor" borderRadius="$5" backgroundColor="$card" overflow="hidden">
      <XStack alignItems="center" gap="$3" paddingHorizontal="$4" paddingVertical="$3" borderBottomWidth={1} borderColor="$borderColor" backgroundColor="$background">
        <YStack width={32} height={32} borderRadius={9} alignItems="center" justifyContent="center" style={{ backgroundColor: `${accent}24` } as never}>
          <Icon name={icon} size={16} color={accent} />
        </YStack>
        <Text role="heading" aria-level={2} flex={1} fontSize={16} fontWeight="700" color="$color" numberOfLines={1}>
          {title}
        </Text>
        {summary ? (
          <Text fontSize={13} color="$muted" numberOfLines={1} flexShrink={1}>
            {summary}
          </Text>
        ) : null}
      </XStack>
      <YStack padding={inset ? 0 : '$4'} gap="$3">
        {children}
      </YStack>
    </YStack>
  );
}

/** What an empty group says, inside its box. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <Text fontSize={14} color="$muted" lineHeight={20}>
      {children}
    </Text>
  );
}
