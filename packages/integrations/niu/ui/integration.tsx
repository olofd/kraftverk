import { Text, YStack } from 'tamagui';

import type { DeviceScreenProps, IntegrationUi } from '@kraftverk/api-client';
import { Card, SectionLabel } from '@kraftverk/ui';

import { BUSY_EVERY_MS, IDLE_EVERY_MS, LIST_EVERY_MS, SLOW_EVERY_MS } from '../src/account.ts';

/** A pace, as a person says it: "every minute", "every 10 minutes". */
const every = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
};

/**
 * How a NIU account asks NIU, said on its page: what a person wonders when a
 * scooter's figures look old. The account asks for every scooter you have
 * on it, at its pace; NIU itself is only as current as the scooter's last
 * report over the mobile network.
 */
function HowNiuIsAsked({ device }: DeviceScreenProps) {
  const held = device.connections.find((connection) => connection.through === null)?.heldBy.name;
  const lines = [
    `Each scooter you have on it is asked ${every(BUSY_EVERY_MS)} while it charges or is switched on, and ${every(IDLE_EVERY_MS)} otherwise; its battery's health and its totals ${every(SLOW_EVERY_MS)}.`,
    `A scooter bound to the account in the NIU app shows up here within ${Math.round(LIST_EVERY_MS / 60_000)} minutes.`,
    'NIU’s figures are the scooter’s last report: parked and switched off, it reports seldom — each reading says how old it is.',
    held ? `Your NIU password is kept by ${held}, and sent only to NIU.` : 'Your NIU password is sent only to NIU.',
  ];
  return (
    <YStack gap="$2">
      <SectionLabel>How NIU is asked</SectionLabel>
      <Card>
        <YStack gap="$2">
          {lines.map((line) => (
            <Text key={line} fontSize={13} color="$muted" lineHeight={19}>
              {line}
            </Text>
          ))}
        </YStack>
      </Card>
    </YStack>
  );
}

/**
 * NIU's own screens for its integration's pages (docs/PLAN-INTEGRATIONS.md
 * §1.1): a panel on an account's page. A scooter's screens are its type's
 * (`./index.ts`).
 */
export default {
  account: HowNiuIsAsked,
} satisfies IntegrationUi;
