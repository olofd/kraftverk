import { useCallback, useMemo, useState } from 'react';
import { YStack } from 'tamagui';

import { describeError, isOnline, type DeviceView } from '@kraftverk/api-client';
import { MAIN_PART, partName, switchConsequence, togglesOf, type Part, type PartToggle } from '@kraftverk/device-sdk';
import { Card, haptic, readingFor, RowSeparator, SectionLabel, ToggleRow, useWriteGate } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useDevices } from '../../state/DevicesProvider';

/** What a part is called on a screen: the device's name for its main part, its own label otherwise. */
const partTitle = (device: DeviceView, part: Part) => (part.id === MAIN_PART ? device.name : part.label);

// --- controls -----------------------------------------------------------------

/**
 * What this device can be told to do — one part's, or all of them. Every
 * control is a command to one of its parts through the holder's gateway —
 * which asks the person to confirm when it matters, and says why — so a tap
 * here has exactly a manual switch's authority.
 */
export function Controls({ device, part }: { device: DeviceView; part?: string }) {
  const { actionsFor } = useDevices();
  const [gate, writes] = useWriteGate<string>();
  const [error, setError] = useState<string | null>(null);
  const toggles = useMemo(() => togglesOf(device.description, device.name).filter((toggle) => part === undefined || toggle.part.id === part), [device, part]);

  const run = useCallback(
    async (toggle: PartToggle, value: boolean) => {
      setError(null);
      haptic();
      try {
        await gate.run({ [toggle.attribute.key]: value }, async () => {
          const result = await actionsFor(device).command({
            part: toggle.part.id,
            capability: toggle.capability,
            command: toggle.command,
            args: { [toggle.argument]: value },
            reason: `${partTitle(device, toggle.part)} from the device screen`,
          });
          if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
          if (result.outcome === 'unverified') setError(result.detail);
        });
      } catch (err) {
        setError(describeError(err) || 'That did not work');
      }
    },
    [actionsFor, device, gate]
  );

  if (toggles.length === 0) return null;
  const unavailable = !isOnline(device.health);

  return (
    <YStack gap="$2">
      <SectionLabel>Controls</SectionLabel>
      <Card inset>
        {toggles.map((toggle, index) => {
          const reading = readingFor(device.readings, toggle.attribute.key);
          const pending = writes.pending.has(toggle.attribute.key);
          const value = pending ? writes.pending.get(toggle.attribute.key) : reading?.value;
          return (
            <YStack key={`${toggle.part.id}:${toggle.attribute.key}`}>
              {index > 0 ? <RowSeparator /> : null}
              <ToggleRow
                title={toggle.part.id === MAIN_PART ? toggle.attribute.label : toggle.part.label}
                subtitle={switchConsequence(
                  toggle.attribute.consequence,
                  // What it feeds, as its links say: only then is it said.
                  device.links
                    .filter((link) => link.role === 'source' && link.part === toggle.part.id)
                    .map((link) => ({ kind: link.kind, target: partName(link.other.name, link.other.part, link.other.partLabel) }))
                )}
                checked={value === true}
                disabled={unavailable}
                pending={pending}
                onCheckedChange={(next) => void run(toggle, next)}
              />
            </YStack>
          );
        })}
      </Card>
      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
