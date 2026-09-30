import { defineNiuScooter } from '@kraftverk/device-niu-scooter';

/**
 * The NIU UQi GT — the GT Sport, as it is sold in some markets — as a model
 * of its own (README.md).
 *
 * For now it is the common NIU scooter in everything but its name and its
 * pictures: what it reports, and how, is what every NIU scooter through NIU's
 * cloud does. What only this model does — once mapped on the owner's 2019 GT
 * Sport — is added here, and stays here.
 */
export default defineNiuScooter({
  id: 'niu.uqi-gt',
  meta: {
    name: 'NIU UQi GT',
    // As NIU's account lists it: the check step offers this model for a scooter reporting one of these.
    models: ['UQi GT Sport', 'UQi GT', 'UQi GT Pro'],
    description: 'The NIU UQi GT and GT Sport: a 45 km/h scooter with one removable 48 V battery. Its charge, charging, range and odometer from NIU’s cloud; with a smart plug in front of its charger, charge it to a limit.',
    support: 'experimental',
    supportNote: 'The common NIU scooter until it is mapped on a 2019 UQi GT Sport.',
  },
});
