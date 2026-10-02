import {
  ApiError,
  API_ERROR_STATUS,
  CLIENT_HEADER,
  CONFIG_SCHEMA_PATH,
  type ApiErrorKind,
  type AutomationRun,
  type AutomationView,
  type Account,
  type AccountDetail,
  type NodeView,
  type DeviceEventView,
  type DeviceView,
  type FoundView,
  type KraftverkApi,
  type LiveUpdate,
  type ProblemView,
  type ServerApi,
  type SightingView,
  type ViewReport,
} from '@kraftverk/api-contract';

import { liveUrl, openLive } from './live.ts';

/*
  KraftverkApi over HTTP and the live socket (docs/PLAN-SHARED-CORE.md,
  principle 4): the same interface the hub answers in the process, so a
  screen asks one thing whether its home is on a server or in its own
  SQLite. Built on `fetch`, which a browser, a phone, Bun and a test all
  have; handed the server's address, never finding it — that is the app's
  platform's to say. A refusal comes back as the `ApiError` the hub threw,
  its kind read from the status; a command or a setting the gateway refused
  is its verdict, as in the process.
*/

export type HttpApiOptions = {
  /** The server's API: `http://192.0.2.10:3333/api`. */
  baseUrl: string;
  /** How a request is made: the platform's `fetch`, or a test's. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Sent with every request besides the one that marks it as the app's: a test's session cookie. */
  headers?: Record<string, string>;
  /** Told when the server asks to sign in: a session that expired while the app was open. */
  onLoginRequired?: (detail: { setupRequired: boolean }) => void;
  /** Told after each request whether the server answered at all — any answer, a refusal too — or could not be reached. */
  onReach?: (reached: boolean) => void;
  /** How the live socket is made: the platform's, or a test's. */
  socket?: (url: string) => WebSocket;
};

/** What a status says, when an answer carries no refusal of the home's: the hub's map, read back. */
const KIND_OF = new Map<number, ApiErrorKind>(
  (Object.entries(API_ERROR_STATUS) as [ApiErrorKind, number][]).filter(([kind]) => kind !== 'needs-yes').map(([kind, status]) => [status, kind])
);

type Body = { error?: string; problems?: string[]; needsConfirmation?: string; loginRequired?: boolean; setupRequired?: boolean };

type How = { query?: Record<string, unknown>; verdict?: boolean; text?: boolean; signal?: AbortSignal; within?: number };

/** One request to a server's API: JSON in and out, the session cookie, the app's header, a refusal as the hub's `ApiError`. */
function requests(options: HttpApiOptions) {
  const base = options.baseUrl.replace(/\/$/, '');
  const send = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  /** A refusal, as the hub said it — or, from what is not the hub's (signing in, a proxy), as its status says. */
  const refusal = (status: number, body: Body | null): ApiError => {
    if (status === 401 && body?.loginRequired) options.onLoginRequired?.({ setupRequired: Boolean(body.setupRequired) });
    const said = ApiError.fromWire(body);
    if (said) return said;
    const kind: ApiErrorKind = body?.needsConfirmation ? 'needs-yes' : status === 401 ? 'forbidden' : (KIND_OF.get(status) ?? (status >= 500 ? 'failed' : 'invalid'));
    const problems = body?.problems ?? [];
    return new ApiError(kind, body?.error ?? `The server answered ${status}`, { problems, ...(body?.needsConfirmation ? { needsConfirmation: body.needsConfirmation } : {}) });
  };

  /**
   * One request: its JSON body in and out. `verdict`: a 409 that carries a
   * gateway's `outcome` is an answer, not a refusal. `within`: how long to
   * wait before the server is taken to be out of reach — a probe's short
   * wait; nothing else is cut short, a setup helper's call to a vendor
   * among them.
   */
  const call = async <T>(method: string, path: string, body?: unknown, how: How = {}): Promise<T> => {
    const query = how.query ? Object.entries(how.query).filter(([, value]) => value !== undefined && value !== null) : [];
    const url = `${base}${path}${query.length ? `?${new URLSearchParams(query.map(([key, value]): [string, string] => [key, String(value)]))}` : ''}`;
    // Its own timer rather than `AbortSignal.timeout`, which a phone may not have.
    const timer = how.within ? new AbortController() : null;
    const timeout = timer ? setTimeout(() => timer.abort(), how.within) : null;
    const signal = timer?.signal ?? how.signal;
    let response: Response;
    try {
      response = await send(url, {
        method,
        headers: { Accept: 'application/json', [CLIENT_HEADER]: 'app', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
        // The session is a cookie; it only travels if asked to.
        credentials: 'include',
      } as RequestInit);
    } catch (error) {
      if (how.signal?.aborted) throw error;
      // Nothing answered: not a refusal, but the home out of reach — said as one, in words.
      options.onReach?.(false);
      throw new ApiError('unavailable', `Can't reach ${base}`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    options.onReach?.(true);
    const text = await response.text();
    const parsed = text ? (() => { try { return JSON.parse(text) as unknown; } catch { return null; } })() : null;
    if (response.ok) return (how.text ? text : parsed) as T;
    if (how.verdict && response.status === 409 && parsed && typeof parsed === 'object' && 'outcome' in parsed) return parsed as T;
    throw refusal(response.status, parsed as Body | null);
  };
  const get = <T>(path: string, query?: Record<string, unknown>) => call<T>('GET', path, undefined, { query });
  return { base, call, get };
}

export function httpApi(options: HttpApiOptions): KraftverkApi {
  const { base, call, get } = requests(options);
  const enc = encodeURIComponent;

  return {
    deviceTypes: () => get('/device-types'),

    devices: {
      list: async () => (await get<{ devices: DeviceView[] }>('/devices')).devices,
      removed: async () => (await get<{ devices: DeviceView[] }>('/devices/removed')).devices,
      get: (id) => get(`/devices/${enc(id)}`),
      update: (id, changes) => call('PATCH', `/devices/${enc(id)}`, changes),
      setPicture: (id, picture) => call('PUT', `/devices/${enc(id)}/picture`, { picture }),
      remove: async (id) => void (await call('DELETE', `/devices/${enc(id)}`)),
      deleteHistory: async (id, name) => ({ samples: (await call<{ samples: number }>('POST', `/devices/${enc(id)}/delete-history`, { name })).samples }),
      history: (id, query) => get(`/devices/${enc(id)}/history`, query),
      changes: (id, query) => get(`/devices/${enc(id)}/changes`, query),
      events: async (id, limit) => (await get<{ events: DeviceEventView[] }>(`/devices/${enc(id)}/events`, { limit })).events,
      command: (id, part, capability, command, body) => call('POST', `/devices/${enc(id)}/parts/${enc(part)}/commands/${enc(capability)}/${enc(command)}`, body, { verdict: true }),
      write: (id, write) => call('PATCH', `/devices/${enc(id)}/attributes`, write, { verdict: true }),
      query: (id, part, capability, query, args) => call('POST', `/devices/${enc(id)}/parts/${enc(part)}/queries/${enc(capability)}/${enc(query)}`, { args }),
      tool: (id, name, body) =>
        body.reading ? get(`/devices/${enc(id)}/tools/${enc(name)}`, body.input ?? {}) : call('POST', `/devices/${enc(id)}/tools/${enc(name)}`, { input: body.input, confirmation: body.confirmation }),
    },

    problems: async (limit) => (await get<{ problems: ProblemView[] }>('/problems', { limit })).problems,

    connections: {
      prefer: (device, connection) => call('POST', `/devices/${enc(device)}/connections/${enc(connection)}/prefer`, {}),
      remove: (device, connection) => call('DELETE', `/devices/${enc(device)}/connections/${enc(connection)}`),
      setSecrets: (device, connection, secrets) => call('PUT', `/devices/${enc(device)}/connections/${enc(connection)}/secrets`, secrets),
      setExportable: (device, connection, exportable) => call('PATCH', `/devices/${enc(device)}/connections/${enc(connection)}`, { secretsExportable: exportable }),
    },

    links: {
      add: (link) => call('POST', '/links', link),
      remove: async (id) => void (await call('DELETE', `/links/${enc(id)}`)),
    },

    setup: {
      start: (input) => call('POST', '/setup', input),
      startHeld: (input) => call('POST', '/setup/held', input),
      get: (id) => get(`/setup/${enc(id)}`),
      discard: async (id) => void (await call('DELETE', `/setup/${enc(id)}`)),
      sightings: async (id) => (await get<{ sightings: SightingView[] }>(`/setup/${enc(id)}/sightings`)).sightings,
      choose: (id, choice) => call('POST', `/setup/${enc(id)}/choose`, choice),
      update: (id, values) => call('PATCH', `/setup/${enc(id)}`, values),
      action: (id, step, action, input, signal) => call('POST', `/setup/${enc(id)}/steps/${enc(step)}/actions/${enc(action)}`, { input }, { signal }),
      discover: (id, step, signal) => call('POST', `/setup/${enc(id)}/steps/${enc(step)}/discover`, {}, { signal }),
      check: (id) => call('POST', `/setup/${enc(id)}/check`, {}),
      save: (id, input) => call('POST', `/setup/${enc(id)}/save`, input),
    },

    nearby: async () => (await get<{ found: FoundView[] }>('/found')).found,

    transports: {
      list: () => get('/transports'),
      diagnostic: (transport, name, query) => get(`/transports/${enc(transport)}/diagnostics/${enc(name)}`, query),
    },

    automations: {
      kit: () => get('/automations/recipes'),
      draft: (draft, self) => call('POST', '/automations/draft', { ...draft, ...(self ? { self } : {}) }),
      list: async (filter) => (await get<{ automations: AutomationView[] }>('/automations', { device: filter?.device })).automations,
      get: (id) => get(`/automations/${enc(id)}`),
      create: (automation) => call('POST', '/automations', automation),
      update: (id, changes) => call('PATCH', `/automations/${enc(id)}`, changes),
      delete: async (id) => void (await call('DELETE', `/automations/${enc(id)}`)),
      start: (id) => call('POST', `/automations/${enc(id)}/start`, {}),
      stop: (id) => call('POST', `/automations/${enc(id)}/stop`, {}),
      check: (id) => call('POST', `/automations/${enc(id)}/check`, {}),
      runs: async (id, limit) => (await get<{ runs: AutomationRun[] }>(`/automations/${enc(id)}/runs`, { limit })).runs,
      runLog: (id, runId) => get(`/automations/${enc(id)}/runs/${enc(runId)}/log`),
      rehearse: (subject, hours) =>
        'automation' in subject ? get(`/automations/${enc(subject.automation)}/rehearse`, { hours }) : call('POST', '/automations/rehearse', { ...subject.draft, timeZone: subject.timeZone, ...(hours ? { hours } : {}) }),
      fromRecipe: (recipe, params) => call('POST', `/automations/recipes/${enc(recipe)}/copy`, { params }),
    },

    configuration: {
      vocabulary: () => get('/config/vocabulary'),
      schema: () => get(CONFIG_SCHEMA_PATH),
      // The server writes its own address into the file's first line.
      export: (request) => call('POST', '/config/export', request),
      plan: (request) => call('POST', '/config/plan', request),
      apply: (answers) => call('POST', '/config/apply', answers),
      elsewhere: () => get('/config/elsewhere'),
    },

    policy: {
      list: () => get('/policy'),
      set: (name, value) => call('PUT', `/policy/${enc(name)}`, { value }),
    },

    timeline: (query = {}) => get('/audit', query),
    world: () => get('/world'),
    vocabulary: () => get('/vocabulary'),
    home: () => get('/home'),

    nodes: {
      join: (node) => call('POST', '/nodes', node),
      list: async () => (await get<{ nodes: NodeView[] }>('/nodes')).nodes,
      forget: async (id) => void (await call('DELETE', `/nodes/${enc(id)}`)),
    },

    held: {
      readings: (device, upload) => call('POST', `/devices/${enc(device)}/readings`, upload),
      store: async (device) => (await get<{ values: Record<string, unknown> }>(`/devices/${enc(device)}/store`)).values,
      keep: async (device, key, entry) => void (await call('PUT', `/devices/${enc(device)}/store/${enc(key)}`, entry)),
      audit: (node, entries) => call('POST', `/nodes/${enc(node)}/audit`, { entries }),
    },

    /** The live socket, opened again when it drops; what the screen shows is said again each time it opens. */
    live(listener: (update: LiveUpdate) => void, live = {}) {
      let shown: ViewReport | null = null;
      const stream = openLive({ url: liveUrl(base), onUpdate: listener, view: () => shown, ...(live.onState ? { onState: live.onState } : {}), ...(options.socket ? { socket: options.socket } : {}) });
      return {
        say: (view) => {
          shown = view;
          stream.say(view);
        },
        close: () => stream.close(),
      };
    },
  };
}

/** How long an address is tried before nothing is taken to answer there. */
const PROBE_MS = 3000;

/**
 * What is a server's own, not a home's (`ServerApi`): signing in, accounts,
 * its version, its log, its reset, the copy kept beside its database — over
 * the same requests as `httpApi`, handed the same address.
 */
export function serverApi(options: HttpApiOptions): ServerApi {
  const { call, get } = requests(options);
  const enc = encodeURIComponent;

  return {
    /**
     * Whether a kraftverk server answers at this address: its sign-in state
     * is the one thing it tells anyone (`/health` answers only its own
     * machine).
     */
    async probe() {
      try {
        const state = await call<{ setupRequired?: unknown }>('GET', '/auth/state', undefined, { within: PROBE_MS });
        return typeof state?.setupRequired === 'boolean';
      } catch {
        return false;
      }
    },
    auth: {
      state: () => get('/auth/state'),
      setup: async (username, password) => (await call<{ user: Account }>('POST', '/auth/setup', { username, password })).user,
      logIn: async (username, password) => (await call<{ user: Account }>('POST', '/auth/login', { username, password })).user,
      logOut: async () => void (await call('POST', '/auth/logout', {})),
      changePassword: async (current, next) => void (await call('POST', '/auth/password', { current, next })),
    },
    accounts: {
      list: async () => (await get<{ users: AccountDetail[] }>('/users')).users,
      add: async (username, password, yourPassword) => (await call<{ user: AccountDetail }>('POST', '/users', { username, password, yourPassword })).user,
      remove: async (id, yourPassword) => void (await call('DELETE', `/users/${enc(id)}`, { yourPassword })),
      setPassword: async (id, password, yourPassword) => void (await call('POST', `/users/${enc(id)}/password`, { password, yourPassword })),
    },
    version: () => get('/version'),
    log: (query = {}) => get('/diagnostics/log', query),
    reset: {
      available: () => get('/admin/reset'),
      run: (secret) => call('POST', '/admin/reset', { secret }),
    },
    snapshot: () => get('/config/snapshot'),
    restoredPlan: (mode) => call('POST', '/config/plan', { restored: true, mode }),
  };
}
