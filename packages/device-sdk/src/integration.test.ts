import { describe, expect, test } from 'bun:test';

import { deviceManifestProblems, integrationManifestProblems, inNamespace, sourceProblem } from './integration.ts';

/*
  The two kinds of package, as their manifests say (docs/PLAN-INTEGRATIONS.md
  §1): an integration is a platform, whose own types are in its namespace; a
  device package is a product on one, named by its id.
*/

describe("an integration's manifest", () => {
  test('a platform with its own types in its namespace is found by it; one with none at all too', () => {
    expect(integrationManifestProblems({ id: 'acme', name: 'Acme', types: [{ id: 'acme.plug', entry: './src/plug.ts', ui: './ui/index.ts', images: ['./assets/plug.png'] }] })).toEqual([]);
    expect(integrationManifestProblems({ id: 'acme-cloud', name: 'Acme Cloud', types: [] })).toEqual([]);
  });

  test('its own types are in its namespace, listed once, each with an entry in the package', () => {
    expect(integrationManifestProblems({ id: 'acme', name: 'Acme', types: [{ id: 'other.plug', entry: './src/plug.ts' }] })).toEqual([
      'types[0]: "other.plug" is the platform\'s own, so it must begin with "acme."',
    ]);
    expect(
      integrationManifestProblems({
        id: 'acme',
        name: 'Acme',
        types: [
          { id: 'acme.plug', entry: './src/plug.ts' },
          { id: 'acme.plug', entry: '../elsewhere.ts' },
        ],
      })
    ).toEqual(['types[1]: "acme.plug" is listed twice', 'types[1]: entry must be a path in the package, like "./src/type.ts"']);
  });

  test('its id is a plain one, and it has a name', () => {
    expect(integrationManifestProblems({ id: 'Acme Cloud', types: [] })).toEqual([
      'id "Acme Cloud" must be lowercase words joined by dashes, like "acme-cloud"',
      'name is required',
    ]);
    expect(integrationManifestProblems(null)).toEqual(['the integration section must be an object']);
  });
});

describe("a device package's manifest", () => {
  test('a product names the platform it is built on, in a namespace of its own; its screens may be its platform\'s', () => {
    expect(deviceManifestProblems({ integration: 'acme', types: [{ id: 'brand.model', entry: './src/type.ts', ui: '@kraftverk/integration-acme/ui' }] })).toEqual([]);
  });

  test('it names a platform, and describes at least one product', () => {
    expect(deviceManifestProblems({ types: [{ id: 'brand.model', entry: './src/type.ts' }] })).toEqual(['integration must name the integration it is built on, like "acme"']);
    expect(deviceManifestProblems({ integration: 'acme', types: [] })).toEqual(['types must list at least one product']);
  });
});

test("a type the platform owns is in its namespace; a product on it need not be", () => {
  const acme = { id: 'acme', name: 'Acme' };
  expect(inNamespace('acme.plug', 'acme')).toBe(true);
  expect(inNamespace('acmeplug.x', 'acme')).toBe(false);
  expect(sourceProblem('acme.plug', { integration: acme, product: false })).toBeNull();
  expect(sourceProblem('brand.model', { integration: acme, product: true })).toBeNull();
  expect(sourceProblem('brand.model', { integration: acme, product: false })).toBe('type "brand.model" is the platform\'s own, so its id must begin with "acme."');
});
