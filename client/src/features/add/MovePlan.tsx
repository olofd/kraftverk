import { Text, YStack } from 'tamagui';

import type { MoveView } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

/**
 * A device you have, moving to another type (docs/PLAN-ZIGBEE.md §2.1), as
 * it will be — read before anything moves: where each thing it measured
 * keeps its history, which part each part becomes, and what of its links,
 * automations and ways comes along or goes.
 */
export function MovePlan({ move }: { move: MoveView }) {
  const carried = move.attributes.filter((attribute) => attribute.to);
  const kept = move.attributes.filter((attribute) => !attribute.to);
  const lostLinks = move.links.filter((link) => !link.kept);
  const lostAutomations = move.automations.filter((automation) => !automation.kept);

  return (
    <YStack gap="$3">
      <Card gap="$2">
        <Text fontSize={15} fontWeight="700">
          {move.device.name} becomes a {move.to.name}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          It is a {move.from.name} now. It stays one device: its name, its history, its links and the automations that use it come with it, as below.
        </Text>
      </Card>

      {carried.length ? (
        <YStack gap="$2">
          <SectionLabel>Its history moves</SectionLabel>
          <Card inset>
            {carried.map((attribute, index) => (
              <YStack key={attribute.key}>
                {index > 0 ? <RowSeparator /> : null}
                <Row title={attribute.label} subtitle={attribute.toLabel === attribute.label ? `Kept as ${attribute.to}` : `Kept as ${attribute.toLabel} (${attribute.to})`} />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {kept.length ? (
        <YStack gap="$2">
          <SectionLabel>No longer reported</SectionLabel>
          <Card inset>
            {kept.map((attribute, index) => (
              <YStack key={attribute.key}>
                {index > 0 ? <RowSeparator /> : null}
                <Row title={attribute.label} subtitle="Nothing it becomes measures this: its history is kept as it is, and it is not reported any more" />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {move.links.length || move.automations.length || move.connectionsRemoved.length ? (
        <YStack gap="$2">
          <SectionLabel>What uses it</SectionLabel>
          <Card inset>
            {move.links.map((link, index) => (
              <YStack key={link.id}>
                {index > 0 ? <RowSeparator /> : null}
                <Row title={link.kept ? 'Kept' : 'Removed'} subtitle={link.summary} />
              </YStack>
            ))}
            {move.automations.map((automation, index) => (
              <YStack key={automation.id}>
                {move.links.length + index > 0 ? <RowSeparator /> : null}
                <Row title={automation.name} subtitle={automation.kept ? 'Still uses it' : 'Needs a part chosen again: listed under Problems after the move'} />
              </YStack>
            ))}
            {move.connectionsRemoved.map((connection, index) => (
              <YStack key={connection.id}>
                {move.links.length + move.automations.length + index > 0 ? <RowSeparator /> : null}
                <Row title={`Its way "${connection.label}" goes`} subtitle={`A ${move.to.name} is not reached that way: it is reached as you are adding it now`} />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {lostLinks.length || lostAutomations.length ? (
        <Text fontSize={12} color="$warning" lineHeight={17}>
          {[
            lostLinks.length ? `${lostLinks.length === 1 ? 'A link goes' : `${lostLinks.length} links go`}` : '',
            lostAutomations.length ? `${lostAutomations.length === 1 ? 'an automation needs' : `${lostAutomations.length} automations need`} a part chosen again` : '',
          ]
            .filter(Boolean)
            .join(', and ')}
          .
        </Text>
      ) : null}
    </YStack>
  );
}
