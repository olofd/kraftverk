import { expect, test, type Page } from '@playwright/test';

import { addSimulated, unique } from './helpers';

/*
  The app on a phone (docs/AUTOMATIONS-UX.md): at 320 and 375 px wide,
  nothing leaves the screen, nothing a finger is meant to touch is smaller
  than 40 px, no choice's words are cut short, and every icon stands on the
  first line of its words — checked on the automation list, an automation's
  page and its form with a step and its condition open, the home page, a
  price service's page, and two devices' settings.
*/

const HEADERS = { 'x-kraftverk-client': 'app' };
const SOC = { read: { role: 'battery', means: 'battery.soc' } };

/** What is wrong with the layout as it is now, in words; empty when nothing is. */
async function problems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const said = (element: Element) =>
      `${element.getAttribute('role') ?? element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? (element as HTMLElement).innerText ?? '').trim().slice(0, 50)}"`;
    const found: string[] = [];
    for (const element of document.querySelectorAll('body *')) {
      if (!shown(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.right > width + 0.5) found.push(`${said(element)} ends at ${Math.round(box.right)} px, past the ${width} px screen`);
    }
    for (const element of document.querySelectorAll('button, [role=button], [role=radio], [role=checkbox], [role=switch], input')) {
      if (!shown(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.height < 40 || box.width < 40) found.push(`${said(element)} is ${Math.round(box.width)} × ${Math.round(box.height)} px, under 40`);
    }
    // A choice's words are whole: "1.8 kW", never "1.8 k…".
    for (const element of document.querySelectorAll('[role=radio] *')) {
      if (shown(element) && element.scrollWidth > element.clientWidth + 1) found.push(`${said(element.closest('[role=radio]')!)} is cut short`);
    }
    for (const row of document.querySelectorAll('[data-icon-label]')) {
      if (!shown(row)) continue;
      const iconBox = row.querySelector('[data-icon-box]');
      const glyph = iconBox?.firstElementChild;
      const label = iconBox?.nextElementSibling;
      const text = label?.querySelector('span, div');
      if (!glyph || !label || !text) continue;
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
      const icon = glyph.getBoundingClientRect();
      const off = icon.top + icon.height / 2 - (label.getBoundingClientRect().top + lineHeight / 2);
      if (Math.abs(off) > 1) found.push(`the icon beside "${(label as HTMLElement).innerText.trim().slice(0, 40)}" is ${off.toFixed(1)} px off its first line`);
    }
    return [...new Set(found)];
  });
}

for (const width of [320, 375]) {
  test(`at ${width} px: the list, an automation's page, and its form fit, are big enough to touch, and line up`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 800 });
    const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
    const plug = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
    // A charge window, its step worked out as it runs, and a long name, as a person might give one.
    const name = unique('Charge the garage station between two levels');
    const made = await request.post('/api/automations', {
      headers: HEADERS,
      data: {
        name,
        rule: {
          roles: {
            battery: { label: 'Battery', description: 'The battery', capabilities: ['battery'] },
            charger: { label: 'What charges it', description: 'What charges it', capabilities: ['switch'] },
          },
          params: { fields: {} },
          when: [{ becomes: { compare: 'lt', left: SOC, right: { value: 15 } }, heldForMinutes: { value: 2 } }, { at: { value: '07:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }],
          then: [
            { command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { compare: 'lt', left: SOC, right: { value: 50 } } } } },
            { ensure: { condition: { compare: 'gt', left: SOC, right: { value: 10 } }, withinSeconds: { value: 20 }, tries: { value: 3 }, retry: [{ wait: { seconds: { value: 5 } } }] } },
          ],
        },
        roles: { battery: { device: station.id, part: 'main' }, charger: { device: plug.id, part: 'main' } },
        starts: {},
        timeZone: 'Europe/Stockholm',
      },
    });
    expect(made.ok(), await made.text()).toBe(true);
    const id = (await made.json()).id as string;

    await page.goto('/automations');
    await expect(page.getByRole('group', { name })).toBeVisible();
    expect(await problems(page)).toEqual([]);

    await page.goto(`/automation/${id}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await page.getByRole('button', { name: 'More' }).click();
    expect(await problems(page)).toEqual([]);

    // Its form: a trigger, a step with its condition, and the step within a step, all open.
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: /^Change trigger 2: / }).click();
    await page.getByRole('button', { name: /^Open step: Turn / }).click();
    await page.getByRole('button', { name: /^Turn it: what kind: .*Choose$/ }).click();
    await expect(page.getByText('On while this holds, off when it does not:')).toBeVisible();
    await page.getByRole('button', { name: /^Open step: Make sure / }).click();
    await page.getByRole('button', { name: /^Open step: Wait 5 s/ }).click();
    expect(await problems(page)).toEqual([]);
  });

  test(`at ${width} px: the home page, a device's page and its settings fit and are big enough to touch`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 800 });
    const station = await addSimulated(request, 'aferiy.p280', unique('Garage P280'));
    const meter = await addSimulated(request, 'atorch.s1w', unique('ATORCH'));
    // A price that is wide as it reads ("0.59 SEK/kWh"), beside where the hour ranks.
    const prices = await addSimulated(request, 'elprisetjustnu.prices', unique('Prices'), { area: 'SE3', currency: 'SEK' });

    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(`^${prices.name}, `) })).toBeVisible();
    expect(await problems(page)).toEqual([]);

    // Its history: which reading, and how far back — a title never squeezed beside the ranges.
    await page.goto(`/device/${prices.id}`);
    await expect(page.getByRole('radiogroup', { name: /: how far back$/ })).toBeVisible();
    expect(await problems(page)).toEqual([]);

    // Five power steps, six delays: every label whole, each a named group.
    for (const device of [station, meter]) {
      await page.goto(`/device/${device.id}/settings`);
      await expect(page.getByRole('heading', { level: 1, name: device.name })).toBeVisible();
      await expect(page.getByRole('radiogroup').first()).toBeVisible();
      expect(await problems(page)).toEqual([]);
      expect(await page.locator('[role=radiogroup]:not([aria-label])').count()).toBe(0);
    }
  });
}
