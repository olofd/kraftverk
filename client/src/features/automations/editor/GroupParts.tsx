import { Fragment } from 'react';
import { Text, YStack } from 'tamagui';

import { groupRole } from '@kraftverk/automation';
import { Card, RowSeparator, ToggleRow } from '@kraftverk/ui';

import { useEditor } from './context';

/*
  The parts of a group — what a "for each" goes through — chosen one by one:
  each part of each of your devices, switched in or out. The group asks of
  each what all of them offer; a new one is made the first time a part is
  switched in.
*/

/** The parts of the group `role` — none yet: one is made when the first part is chosen. `onRole`: the group the parts are now in. */
export function GroupParts({ role, label, onRole }: { role: string | null; label: string; onRole?: (role: string) => void }) {
  const editor = useEditor();
  const chosen = role ? (editor.draft.groups[role] ?? []) : [];
  const has = (device: string, part: string) => chosen.some((binding) => binding.device === device && binding.part === part);
  // Every part of every device — those already in it first, in their order.
  const options = editor.parts(() => true).filter((option) => !option.role || option.role === role);
  const toggle = (device: string, part: string) => {
    const next = has(device, part) ? chosen.filter((binding) => !(binding.device === device && binding.part === part)) : [...chosen, options.find((option) => option.binding.device === device && option.binding.part === part)!.binding];
    const described = next.flatMap((binding) => {
      const found = editor.devices.find((each) => each.id === binding.device);
      return found ? [{ binding, description: found.description }] : [];
    });
    const made = groupRole(editor.draft, role, described);
    editor.change(() => made.draft);
    // A new group: what names it is told after it is there.
    if (made.role !== role) onRole?.(made.role);
  };
  return (
    <YStack gap="$1">
      <Text fontSize={13} color="$muted" lineHeight={18}>
        {chosen.length ? `${chosen.length === 1 ? 'One part' : `${chosen.length} parts`}: ${editor.name(role!)}` : 'Choose the parts it goes through.'}
      </Text>
      <Card inset>
        <YStack role="group" aria-label={label}>
          {options.map((option, index) => (
            <Fragment key={option.key}>
              {index > 0 ? <RowSeparator /> : null}
              <ToggleRow title={option.title} subtitle={option.subtitle} checked={has(option.binding.device, option.binding.part)} onCheckedChange={() => toggle(option.binding.device, option.binding.part)} />
            </Fragment>
          ))}
        </YStack>
      </Card>
    </YStack>
  );
}
