/**
 * What a home answers, as shapes: declared once in `@kraftverk/api-contract`.
 * Re-exported here for the screens a device package draws: by the dependency
 * rule they reach the API through this package and the UI kit alone, so this
 * is their one window onto its types. The app imports the contract itself.
 */

export type * from '@kraftverk/api-contract';
