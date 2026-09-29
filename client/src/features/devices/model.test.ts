import { describe, expect, test } from 'bun:test';

import type { DeviceDescription, LinkView } from '@kraftverk/api-client';
import { linkId, MAIN_PART, savedDeviceId } from '@kraftverk/device-sdk';

import { fedBy, feedsTo, settingsForms, togglesOf } from './model';

/*
  The generic panels are these, drawn: which switches a device gets, which
  settings forms, what feeds what — decided from its description alone, for a
  device nobody wrote a screen for.
*/

const STRIP: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Strip', kind: 'device' },
    { id: 'socket.1', label: 'Socket 1', kind: 'outlet', offers: ['switch'] },
    { id: 'socket.2', label: 'Socket 2', kind: 'outlet', offers: ['switch'] },
    // Reports whether it is on, but takes no command: no switch for it.
    { id: 'usb', label: 'USB', kind: 'outlet' },
  ],
  attributes: [
    { key: 'socket.1.on', part: 'socket.1', label: 'On', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'socket.2.on', part: 'socket.2', label: 'On', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'usb.on', part: 'usb', label: 'On', value: { type: 'boolean' }, means: 'p.usbOn' },
    { key: 'childLock', label: 'Child lock', value: { type: 'boolean' }, access: 'write', category: 'config', section: 'Safety' },
    { key: 'led', label: 'Indicator', value: { type: 'enum', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] }, access: 'write', category: 'config' },
    { key: 'maxWatts', label: 'Overload at', value: { type: 'number', unit: 'W', min: 100, max: 3600 }, access: 'write', category: 'config', section: 'Safety' },
  ],
};

describe('the generic panels, from a description', () => {
  test('a switch for each part that takes one, and none for a part that only reports', () => {
    const toggles = togglesOf(STRIP, 'Strip');
    expect(toggles.map((toggle) => [toggle.part.id, toggle.capability, toggle.command, toggle.argument, toggle.attribute.key])).toEqual([
      ['socket.1', 'switch', 'set', 'on', 'socket.1.on'],
      ['socket.2', 'switch', 'set', 'on', 'socket.2.on'],
    ]);
  });

  test('a settings form per section, in the order declared, each field its attribute’s', () => {
    const forms = settingsForms(STRIP);
    expect(forms.map((form) => [form.section, form.keys])).toEqual([
      ['Safety', ['childLock', 'maxWatts']],
      ['Settings', ['led']],
    ]);
    expect(forms[0]!.schema.fields.maxWatts).toMatchObject({ type: 'number', unit: 'W', min: 100, max: 3600 });
  });

  test('what feeds each part, from the links it is the target of', () => {
    const links: LinkView[] = [
      { id: linkId('l-1'), kind: 'feeds', role: 'target', part: 'input.ac', other: { id: savedDeviceId('d-plug'), name: 'Charger plug', part: MAIN_PART, partLabel: '' } },
      { id: linkId('l-2'), kind: 'feeds', role: 'source', part: 'outlet.ac', other: { id: savedDeviceId('d-cabin'), name: 'Cabin station', part: 'input.ac', partLabel: 'Mains' } },
    ];
    expect(fedBy(links)).toEqual({ 'input.ac': 'Charger plug' });
    expect(feedsTo(links)).toEqual({ 'outlet.ac': 'Cabin station — Mains' });
  });
});
