import { dayAfter, defineFunction, defineRecipe, zonedInstant } from '@kraftverk/device-sdk';

/**
 * What the weather brings to automations (docs/AUTOMATIONS.md): a function
 * that says whether a day looks sunny, and the recipe built on it.
 *
 * The function asks any part that offers `weather.forecast` — this service,
 * or another that answers the same query — so a recipe written against it
 * works with whichever forecast you have.
 */

/** The hours a day's sunshine is judged over, on the owner's clock: 09:00 to 17:00. */
const DAYLIGHT = { from: 9, to: 17 };

/** What the `hourly` query answers with, as far as this needs: the start of each hour, and its cloud. */
type Hour = { at: string; cloudCoverPercent: number | null };

const HOURS = Array.from({ length: 18 }, (_, i) => String(i + 5).padStart(2, '0') + ':00');

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const skyLooks = defineFunction({
  id: 'open-meteo.weather.skyLooks',
  label: 'How the sky looks',
  description: 'Sunny or cloudy, by the average cloud cover between 09:00 and 17:00 on the day asked about.',
  needs: { capabilities: ['weather.forecast'] },
  args: {
    day: { type: 'enum', options: [{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }] },
    cloudMax: { type: 'number', unit: '%', min: 0, max: 100 },
  },
  returns: { type: 'enum', options: [{ value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }] },

  async evaluate({ part, args, now, timeZone }) {
    const session = part.session;
    if (!session?.query) return { value: null, detail: `${part.name} is not answering: ${part.offline}` };
    let hours: Hour[];
    try {
      hours = (await session.query({ part: part.part, capability: 'weather.forecast', query: 'hourly', args: { hours: 72 } })) as Hour[];
    } catch (error) {
      return { value: null, detail: `${part.name} could not answer: ${(error as Error).message}` };
    }
    if (!Array.isArray(hours)) return { value: null, detail: `${part.name} answered with something that is not a forecast` };

    const which = args.day === 'tomorrow' ? 'tomorrow' : 'today';
    const date = dayAfter(now, timeZone, which === 'tomorrow' ? 1 : 0);
    const from = zonedInstant({ ...date, hour: DAYLIGHT.from, minute: 0 }, timeZone).getTime();
    const to = zonedInstant({ ...date, hour: DAYLIGHT.to, minute: 0 }, timeZone).getTime();
    const clouds = hours
      .filter((hour) => {
        const at = Date.parse(hour.at);
        return at >= from && at < to;
      })
      .map((hour) => hour.cloudCoverPercent)
      .filter((value): value is number => typeof value === 'number');
    // A forecast with a gap is not a forecast of that day: nothing is guessed.
    if (clouds.length < DAYLIGHT.to - DAYLIGHT.from) return { value: null, detail: `${part.name}'s forecast does not cover ${which} between 09:00 and 17:00` };

    const cloud = Math.round(clouds.reduce((sum, value) => sum + value, 0) / clouds.length);
    const looks = cloud <= Number(args.cloudMax ?? 40) ? 'sunny' : 'cloudy';
    return { value: looks, detail: `${capitalise(which)} looks ${looks}: ${cloud} % cloud on average between 09:00 and 17:00` };
  },
});

/** "If tomorrow is sunny, turn the plug on" — or off, or on a cloudy day. */
export const forecastSwitch = defineRecipe({
  id: 'open-meteo.weather.forecast-switch',
  label: 'Switch by the forecast',
  description: 'Once a day, switch something on or off depending on whether the day looks sunny.',
  sentence: 'At {at}, if {day} looks {condition} by {forecast}, turn {switch} {action}.',
  roles: {
    forecast: { label: 'Forecast', description: 'Where the forecast comes from', capabilities: ['weather.forecast'] },
    switch: { label: 'What to switch', description: 'A plug, or one outlet of a station', capabilities: ['switch'] },
  },
  params: {
    fields: {
      at: {
        type: 'enum',
        title: 'When',
        description: 'The time of day it looks at the forecast and acts.',
        default: '07:00',
        options: HOURS.map((hour) => ({ value: hour, label: hour })),
      },
      day: {
        type: 'enum',
        title: 'Which day',
        default: 'today',
        options: [
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
        ],
      },
      condition: {
        type: 'enum',
        title: 'If it looks',
        default: 'sunny',
        options: [
          { value: 'sunny', label: 'Sunny' },
          { value: 'cloudy', label: 'Cloudy' },
        ],
      },
      cloudMax: {
        type: 'number',
        title: 'Sunny means cloud cover at most',
        description: 'The average between 09:00 and 17:00.',
        unit: '%',
        min: 0,
        max: 100,
        step: 5,
        default: 40,
      },
      action: {
        type: 'enum',
        title: 'Then turn it',
        default: 'on',
        options: [
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      },
    },
  },
  when: [{ at: { param: 'at' } }],
  if: {
    compare: 'eq',
    left: { call: 'open-meteo.weather.skyLooks', role: 'forecast', args: { day: { param: 'day' }, cloudMax: { param: 'cloudMax' } } },
    right: { param: 'condition' },
  },
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { compare: 'eq', left: { param: 'action' }, right: { value: 'on' } } } } }],
});
