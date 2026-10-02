import type { RunLog } from '@kraftverk/api-contract';

/*
  A run's log, given back (docs/SEQUENCES.md): as JSON it is the API's own
  shape; as a table, here — one row for each step, each reading and each
  change in whether a device could be reached, in time order, to read in a
  spreadsheet.
*/

/** A field of a CSV row: quoted when it holds a comma, a quote or a line break. */
const csvField = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * A run's log as one table in time order: its steps, every reading and
 * whether each device could be reached — each row when it happened, which
 * device, which value, and what it was.
 */
export function runLogCsv(log: RunLog): string {
  const devices = new Map(log.devices.map((device) => [device.id, device.name]));
  const keys = new Map(log.keys.map((key) => [`${key.device} ${key.key}`, key]));
  const rows: { at: string; cells: string[] }[] = [];
  for (const step of log.run.steps) {
    rows.push({ at: step.at, cells: [step.at, step.at, 'step', '', '', '', '', step.within ?? '', step.what, step.outcome, '', step.detail] });
  }
  for (const reading of log.readings) {
    const key = keys.get(`${reading.device} ${reading.key}`);
    const value = typeof reading.value === 'string' ? reading.value : JSON.stringify(reading.value);
    rows.push({ at: reading.at, cells: [reading.at, reading.heardAt, 'reading', reading.device, devices.get(reading.device) ?? '', key?.part ?? '', reading.key, key?.label ?? reading.key, '', value, key?.unit ?? '', ''] });
  }
  for (const reach of log.reach) {
    rows.push({ at: reach.at, cells: [reach.at, reach.at, 'reach', reach.device, devices.get(reach.device) ?? '', '', '', 'Reachable', '', String(reach.reachable), '', reach.detail] });
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const header = ['at', 'heard_at', 'type', 'device_id', 'device', 'part', 'key', 'label', 'step', 'value', 'unit', 'detail'];
  return [header, ...rows.map((row) => row.cells)].map((cells) => cells.map(csvField).join(',')).join('\r\n') + '\r\n';
}
