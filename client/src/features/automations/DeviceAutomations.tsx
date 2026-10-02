

import { AutomationList } from './AutomationList';
import { useAutomations } from './useAutomations';

/**
 * The automations a device takes part in, at the bottom of its page — the
 * same list, and the same cards, as the automations screen, kept to this
 * device: run or stopped from here, opened to their own page, and a new one
 * made from here (docs/AUTOMATIONS-UX.md).
 */
export function DeviceAutomations({ device }: { device: { id: string; name: string } }) {
  // Its runs move on the live stream: read again when one does, or now and then while the stream is down.
  const { automations, replace } = useAutomations({ device: device.id });
  if (!automations) return null;
  return <AutomationList automations={automations} onChanged={replace} title="Automations" device={device} empty={`No automation uses ${device.name} yet.`} />;
}
