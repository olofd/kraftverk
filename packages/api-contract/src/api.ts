import type { AutomationDraft, Rule, ScriptCheck } from '@kraftverk/automation';
import type { Challenge, SignIn, Statement } from '@kraftverk/identity';
import type { AutomationId, ConfigValues, ConnectionId, LinkId, NodeId, PolicyValueName, ResourceKind, SavedDeviceId, SetupActionResult, Value } from '@kraftverk/device-sdk';
import type { GatewayResult, WriteResult } from '@kraftverk/gateway';
import type { Vocabulary } from '@kraftverk/home-file';

import type { Account, AccountDetail, AuthState } from './accounts.ts';
import type { Rehearsal, VocabularyView, WorldView } from './assistant.ts';
import type { AutomationChanges, AutomationDraftView, AutomationKit, AutomationRun, AutomationView, NewAutomation, RunLog } from './automations.ts';
import type { ConfigExported, ConfigExportRequest, ConfigSnapshotView, ImportAnswers, ImportApplied, ImportPlan } from './configuration.ts';
import type { MapRegionAsk, MapRegionsView } from './map.ts';
import type { AttributeWrite, ChangesQuery, CommandBody, DeviceChanges, DeviceHistory, DevicePeople, DeviceTypeList, DeviceView, ElsewhereView, HistoryQuery, HeldBy, FamilyElsewhere, LinkRecord, NewLink, PictureRef, ToolBody, TrackPointView } from './devices.ts';
import type { DeviceEventView, LiveState, LiveStream, LiveUpdate, NeedsYouView, ProblemView } from './live.ts';
import type { FoundFamily, InvitationInput, InvitationMade, InvitationView, Joined, MemberChanges, PersonView, SharingChanges, SharingLevel, PresenceView, NotificationView, WebPushSubscription } from './people.ts';
import type { HomeInput, HomeView, ZoneInput, ZoneView, LabelInput, Labelled, LabelTarget, LabelView, OpeningInput, OpeningView, PlacementInput, PlacementView, SpaceHistory, SpaceHistoryQuery, SpaceInput, SpaceView, OccupancyView, ModeView, ModeInput, HomeModeView, ModeSet, ModeAxis } from './homes.ts';
import type { MediaData, MediaView, NewMedia } from './media.ts';
import type { AuditEntry, AuditUpload, HeldReadings, HeldReadingsTaken, FamilyView, NodeJoin, NodeView, PolicyValueView, ServerLogLine, TransportList } from './nodes.ts';
import type { ScriptInput, ScriptTried, ScriptTry, ScriptView } from './scripts.ts';
import type { CheckOutcome, DraftView, FoundAt, FoundView, HeldSetupInput, KeptView, SaveInput, SightingView } from './setup.ts';

/*
  The one interface (docs/ARCHITECTURE.md, decision 24): everything a home
  answers, `KraftverkApi`, whoever asks and however it is reached — a
  server over HTTP, a home in the app's own worker, a node following a
  master — and what a server answers besides (`ServerApi`).
*/

/** `GET /api/version`. */
export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  /** Every write to hardware is refused. */
  readOnly: boolean;
};

/**
 * Who is asking a home: what the gateway binds a person's yes to, what it
 * refuses an assistant, what setup drafts and import plans belong to, and
 * who the timeline names. The server makes one from a request's session;
 * an app with no server, one for its owner.
 */
export type Caller =
  /**
   * A person, by the name the timeline knows them by, and their person id —
   * absent only for a server's account that names no person yet — and, on a
   * server, their account: what the apps they sign in on belong to.
   */
  | { kind: 'person'; id?: string; name: string; account?: string }
  /** An assistant acting for a person: it does what needs no one's yes, and is refused the rest. */
  | { kind: 'agent'; for: string }
  /**
   * An automation's script, as one of its runs takes a step of it
   * (docs/PLAN-SCRIPTS.md §7.1): for the person whose yes it acts on, with
   * their role — none when nobody's — and its run, whose switches the
   * gateway counts as a step's. Refused what a person must say yes to.
   */
  | { kind: 'automation'; id: string; name: string; for: string | null; run: { id: string; askedBy: 'person' | 'agent' | null } };

/** What kind of caller asks: a person, or an assistant acting for one. */
export type CallerKind = Caller['kind'];

/**
 * Every call of an interface of calls, by its path — `'devices.command'`,
 * `'world'` — what a call is decided by, and named by when it crosses.
 */
export type ApiPath<T> = {
  [K in keyof T & string]: T[K] extends (...args: never[]) => unknown ? K : T[K] extends object ? `${K}.${ApiPath<T[K]>}` : never;
}[keyof T & string];

/**
 * Everything a home answers, whoever asks and wherever it is kept
 * (docs/PLAN-SHARED-CORE.md, principle 4): `@kraftverk/hub` answers it in
 * the process (`hub.as(caller)`), `@kraftverk/api-client` over HTTP, and
 * the server's routes are an adapter from one to the other. A refusal is an
 * `ApiError`; a command the gateway refuses is an answer, its verdict.
 * Accounts, sign-in and the reset are the server's, and not here.
 */
export interface KraftverkApi {
  /** What can be added: every installed type, with where each of its methods can be held here. */
  deviceTypes(): Promise<DeviceTypeList>;
  devices: {
    /** The devices you have, each with what it is doing. */
    list(): Promise<DeviceView[]>;
    /** Removed ones, kept with their history. */
    removed(): Promise<DeviceView[]>;
    /** One, removed or not. */
    get(id: SavedDeviceId): Promise<DeviceView>;
    /** Its name, and the key a configuration knows it by. */
    update(id: SavedDeviceId, changes: { name?: string; key?: string }): Promise<DeviceView>;
    /** Which picture it shows. */
    setPicture(id: SavedDeviceId, picture: PictureRef): Promise<DeviceView>;
    /** Pauses it — kept, with its history, and not reached until resumed — or resumes it. */
    setPaused(id: SavedDeviceId, paused: boolean): Promise<DeviceView>;
    /** Keeps where it has been for so many days, 1 to 366, or none of it: null forgets what was kept. */
    setTrack(id: SavedDeviceId, days: number | null): Promise<DeviceView>;
    /**
     * Who it is with (docs/PLAN-WORLD-MODEL.md §8.8), as given — each role
     * left out stays as it is: who carries it, its usual driver, whose it is,
     * who uses it. Each a person in the family; one carrier, one driver.
     */
    setPeople(id: SavedDeviceId, people: Partial<DevicePeople>): Promise<DeviceView>;
    /** Where it stands from now on — a space of a home, perhaps at an opening — or, null, nowhere said: where it stood is kept. */
    place(id: SavedDeviceId, placement: PlacementInput | null): Promise<DeviceView>;
    /** Where it has stood, oldest first. */
    placements(id: SavedDeviceId): Promise<PlacementView[]>;
    /** Where it has been since a time, oldest first, while that is kept. */
    track(id: SavedDeviceId, since: string): Promise<TrackPointView[]>;
    /** Removes it, keeping its history: adding it again brings it back. */
    remove(id: SavedDeviceId): Promise<void>;
    /** A removed device and everything it recorded, gone: its name, typed back, confirms it. */
    deleteHistory(id: SavedDeviceId, name: string): Promise<{ samples: number }>;
    /** One measurement over a span, thinned for a chart. */
    history(id: SavedDeviceId, query: HistoryQuery): Promise<DeviceHistory>;
    /** Every change of an on/off or an enum in a span. */
    changes(id: SavedDeviceId, query: ChangesQuery): Promise<DeviceChanges>;
    /** What it said happened, newest first. */
    events(id: SavedDeviceId, limit?: number): Promise<DeviceEventView[]>;
    /** A command to one of its parts, through the gateway: its verdict, refused or not. */
    command(id: SavedDeviceId, part: string, capability: string, command: string, body: CommandBody): Promise<GatewayResult>;
    /** Settings it keeps, through the gateway: its verdict, refused or not. */
    write(id: SavedDeviceId, write: AttributeWrite): Promise<WriteResult>;
    /** A query its capability declares — a forecast's hours — answered in the type the capability declares. */
    query(id: SavedDeviceId, part: string, capability: string, query: string, args: Record<string, Value>): Promise<Value>;
    /**
     * One of its type's tools, with the answer it declares. `reading`: asked
     * as a read, so one that writes is refused; one that declares what it
     * cannot undo wants a person's yes, sent back as `confirmation`.
     */
    tool(id: SavedDeviceId, name: string, body: ToolBody & { reading?: boolean }): Promise<unknown>;
    /**
     * Lets devices join a bridge that new devices join (a Zigbee coordinator)
     * for `seconds` — 0 closes it — and answers until when. Refused while
     * read-only; on the timeline.
     */
    join(id: SavedDeviceId, seconds: number): Promise<{ until: string | null }>;
  };
  /** Warnings and errors across the devices you have, newest first. */
  problems(limit?: number): Promise<ProblemView[]>;
  /** What waits on a person: a sign-in to give again, a device found behind an account. */
  needsYou(): Promise<NeedsYouView[]>;
  /**
   * Adding a device (docs/DATA-MODEL.md §1): a draft only its starter sees,
   * each step that touches the device run where it will be held, nothing
   * kept until the save.
   */
  setup: {
    /**
     * Begins one over a method of a type, held by whoever its way says
     * (`ways`): the master, unless this node holds it for the master. A way
     * through a bridge may name the bridge (`through`); without it, every
     * bridge open here it can go through is offered.
     */
    start(input: { typeId: string; methodId?: string | null; holder?: HeldBy; through?: string }): Promise<DraftView>;
    /** One a node that follows will hold, from what it learnt reading the device itself: never a secret. */
    startHeld(input: HeldSetupInput): Promise<DraftView>;
    /**
     * Sets one of a device's ways up again — signed in again, its key
     * fetched again — through the same steps as adding it: its credentials,
     * then a check that it is the same device. Saving changes that way; it
     * adds nothing.
     */
    again(input: { deviceId: string; connectionId: string }): Promise<DraftView>;
    get(id: string): Promise<DraftView>;
    discard(id: string): Promise<void>;
    /** What the transport sees that the type's protocol recognises. */
    sightings(id: string): Promise<SightingView[]>;
    /**
     * The device: one it sees, an address typed, or one picked in the
     * platform's own chooser (a browser's Bluetooth picker) — asked
     * straight from a person's tap; dismissed, nothing is chosen.
     */
    choose(id: string, choice: { address: string; through?: string } | { manual: string } | { chooser: { showAll?: boolean } }): Promise<DraftView>;
    update(id: string, values: { device?: ConfigValues; connection?: ConfigValues }): Promise<DraftView>;
    /** A step's helper — fetching a key — run where it is held; a secret it finds is kept there, and a placeholder answered. */
    action(id: string, step: string, action: string, input: ConfigValues, signal?: AbortSignal): Promise<SetupActionResult>;
    discover(id: string, step: string, signal?: AbortSignal): Promise<SetupActionResult>;
    /** Reads it once: new, yours, yours before, another model, or no answer. */
    check(id: string): Promise<CheckOutcome>;
    /** The device, its connection, its secrets and its links, in one go. */
    save(id: string, input: SaveInput): Promise<DeviceView>;
  };
  /** What the transports see, and the bridges open here have behind them, that nothing you have is reached by: "found near you". Ignored ones are listed, marked. */
  nearby(): Promise<FoundView[]>;
  /** Not to be offered again: something found, by where it was found. */
  ignoreFound(at: FoundAt): Promise<void>;
  /** Offered again. */
  unignoreFound(at: FoundAt): Promise<void>;
  integrations: {
    /** What an integration keeps between setups — an account's listing with its keys — each said, never shown. */
    kept(integration: string): Promise<KeptView[]>;
    /** Forgotten: the next setup asks for it afresh. */
    forget(integration: string, key: string): Promise<void>;
  };
  transports: {
    /** What this home reaches devices over, each running or not, and why not. */
    list(): Promise<TransportList>;
    /** One of a transport's read-only diagnostics, by name. */
    diagnostic(transport: string, name: string, query: Record<string, string>): Promise<unknown>;
  };
  connections: {
    /** This way first, whenever it can be reached. */
    prefer(device: SavedDeviceId, connection: ConnectionId): Promise<DeviceView>;
    /** One way to reach it removed: not the last. */
    remove(device: SavedDeviceId, connection: ConnectionId): Promise<DeviceView>;
    /** A connection's secrets replaced: write-only, as every secret is. */
    setSecrets(device: SavedDeviceId, connection: ConnectionId, secrets: Record<string, string>): Promise<DeviceView>;
    /** Whether its secrets may leave in an export as plain text. Turning it on, a server with accounts asks for your password again. */
    setExportable(device: SavedDeviceId, connection: ConnectionId, exportable: boolean, yourPassword?: string): Promise<DeviceView>;
  };
  links: {
    /** A fact about the house, between two parts. */
    add(link: NewLink): Promise<LinkRecord>;
    remove(id: LinkId): Promise<void>;
  };
  /**
   * Automations (docs/AUTOMATIONS.md): what they start from, the ones their
   * owners build, their runs. Letting one act, and changing one that acts,
   * wants a person's yes, sent back as `confirmation`.
   */
  automations: {
    /** The recipes to start from, and the functions a condition may ask. */
    kit(): Promise<AutomationKit>;
    /** A draft checked and said, nothing kept. `self`: the automation it is, so a chain back to it is seen. */
    draft(draft: AutomationDraft, self?: AutomationId | null): Promise<AutomationDraftView>;
    /** Every one — or those a device fills a role of. */
    list(filter?: { device?: SavedDeviceId }): Promise<AutomationView[]>;
    get(id: AutomationId): Promise<AutomationView>;
    /** Made only watching on its own. */
    create(automation: NewAutomation): Promise<AutomationView>;
    update(id: AutomationId, changes: AutomationChanges): Promise<AutomationView>;
    delete(id: AutomationId): Promise<void>;
    /** Played: it runs now, for real, whatever its mode. */
    start(id: AutomationId): Promise<AutomationView>;
    /** Its run stopped: what it does if stopped runs. */
    stop(id: AutomationId): Promise<AutomationView>;
    /** What it would do now: decided, never acted on, never kept. */
    check(id: AutomationId): Promise<AutomationRun>;
    /** Its runs, the latest first. */
    runs(id: AutomationId, limit?: number): Promise<AutomationRun[]>;
    /** One of its runs with what its devices said while it ran. */
    runLog(id: AutomationId, runId: string): Promise<RunLog>;
    /** A rule rehearsed on the last hours of history — a draft, or one kept: nothing sent. */
    rehearse(subject: { draft: AutomationDraft; timeZone: string } | { automation: AutomationId }, hours?: number): Promise<Rehearsal>;
    /** A recipe copied into a rule of its own, its settings — held to their schema — written into its blocks. */
    fromRecipe(recipe: string, params: Record<string, Value>): Promise<Rule>;
  };
  /** Scripts in TypeScript, for automations (docs/PLAN-SCRIPTS.md): the family's, each by its key. */
  scripts: {
    /** Every one, by name, with what the home's engine reads from each. */
    list(): Promise<ScriptView[]>;
    get(id: string): Promise<ScriptView>;
    /** Kept, when it reads without a problem; refused with each problem, by line, when it does not. */
    create(input: ScriptInput): Promise<ScriptView>;
    /** Its name, its key, or its source changed: a new source is read first, and refused as a new script is. */
    update(id: string, changes: Partial<ScriptInput>): Promise<ScriptView>;
    remove(id: string): Promise<void>;
    /** A script read as the home's engine reads it, nothing kept: what it declares, or what is wrong with it, by line. */
    check(source: string): Promise<ScriptCheck>;
    /**
     * One of a script's steps tried now, as written — as the person asking, each call through the gate as
     * theirs, each act through the gateway: what it did, its answer, what it would remember. Nothing is kept.
     */
    run(input: ScriptTry): Promise<ScriptTried>;
    /** The types a script is written against, for this home: the SDK and each device, by key — what the editor checks and completes with. */
    types(): Promise<string>;
  };
  /** A home in one file (docs/CONFIG.md): what a file may name here, its schema, an export, an import in two steps. */
  configuration: {
    /** What a file may name here: the installed types, and the keys of what you have. */
    vocabulary(): Promise<Vocabulary>;
    /** The JSON Schema of a file: what is installed, nothing you have. */
    schema(): Promise<unknown>;
    /** What you have, as a file — its secrets left out, sealed, or plain where allowed. `schemaUrl`: for its first line. */
    export(request: ConfigExportRequest, options?: { schemaUrl?: string }): Promise<ConfigExported>;
    /** What importing a file would do, nothing written. */
    plan(request: { text: string; mode?: 'merge' | 'replace'; passphrase?: string } | { from: FamilyElsewhere; mode?: 'merge' | 'replace' }): Promise<ImportPlan>;
    /** A plan applied, with its answers, in one transaction; what it sets acting or removes wants a person's yes. */
    apply(answers: ImportAnswers): Promise<ImportApplied>;
    /** What a home this node keeps beside the one it shows has, to bring in (`plan({ from })`); null when there is none — always, for a server's own home. */
    elsewhere(): Promise<ElsewhereView>;
  };
  /** What the home sets as a whole that declarations name: how much is a load, the reserve. */
  policy: {
    list(): Promise<PolicyValueView[]>;
    /** One set within its bounds, or back to its default with null. */
    set(name: PolicyValueName, value: number | null): Promise<PolicyValueView[]>;
  };
  /** The timeline, newest first: all of it, one kind of thing's, or one thing's; `before` an entry's id pages back. */
  timeline(query?: { limit?: number; resourceKind?: ResourceKind; resource?: string; before?: number }): Promise<AuditEntry[]>;
  /** The house as a model reads it: every device, its parts, what each offers and reports, how fresh, and the links. */
  world(): Promise<WorldView>;
  /** The words the world is said in: capabilities, meanings, link kinds, recipes, the home's values. */
  vocabulary(): Promise<VocabularyView>;
  /** The family: what its people call it, and which node is its master. */
  family(): Promise<FamilyView>;
  /** Its homes (docs/PLAN-WORLD-MODEL.md §8.4): each a place, with its own clock. Always at least one. */
  homes: {
    /** The homes it has, in their order; with those it left, `removed`. */
    list(options?: { removed?: boolean }): Promise<HomeView[]>;
    add(input: HomeInput): Promise<HomeView>;
    update(id: string, changes: Partial<HomeInput>): Promise<HomeView>;
    /** Left, or moved from: archived, what was recorded there kept. Never its last. */
    remove(id: string): Promise<HomeView>;
  };
  /** A person's own notifications (docs/PLAN-WORLD-MODEL.md §8.14): their inbox, and where their apps are woken. */
  notifications: {
    /** Their inbox, newest first. */
    list(): Promise<NotificationView[]>;
    /** One read — or, null, every one. */
    read(id: string | null): Promise<void>;
    /** The public key pushes are signed with, for a browser to subscribe with; null where nothing sends a push. */
    pushKey(): Promise<string | null>;
    /** This app — a node, by its id — woken with their notifications at this subscription. */
    keepPushEndpoint(nodeId: string, subscription: WebPushSubscription): Promise<void>;
    forgetPushEndpoint(nodeId: string): Promise<void>;
    /** A test, to themselves: in their inbox, and pushed where it can be. */
    test(): Promise<NotificationView>;
  };
  /** Where each member is, as far as each shares (docs/PLAN-WORLD-MODEL.md §8.9, §11). */
  presence: {
    list(): Promise<PresenceView[]>;
  };
  /** A home's modes on two axes (docs/PLAN-WORLD-MODEL.md §8.10): the built-in ones and the family's own, and which each home is in. */
  modes: {
    /** Every mode, presence first; with those let go, `removed`. */
    list(options?: { removed?: boolean }): Promise<ModeView[]>;
    add(input: ModeInput): Promise<ModeView>;
    /** A family's own mode renamed, rekeyed, its icon changed. A built-in one is not. */
    update(id: string, changes: Partial<Omit<ModeInput, 'axis'>>): Promise<ModeView>;
    /** A family's own mode let go: history names it. */
    remove(id: string): Promise<ModeView>;
    /** A home's mode on each axis now, and what is set to come. */
    of(homeId: string): Promise<HomeModeView[]>;
    /** A home set to a mode — now, or ahead: a vacation from Saturday to Sunday week. */
    set(homeId: string, input: ModeSet): Promise<HomeModeView[]>;
    /** A mode planned ahead let go, by its axis and when it was to begin: what is before it lasts on. */
    cancel(homeId: string, input: { axis: ModeAxis; from: string }): Promise<HomeModeView[]>;
  };
  /** Which spaces of a home have someone in them, whoever they are (§8.9). */
  occupancy: {
    /** A home's spaces with someone in them now. */
    now(homeId: string): Promise<OccupancyView[]>;
    /** When a space had someone in it, over the hours just gone — at most 30 days, what is kept — newest first. */
    history(spaceId: string, options?: { hours?: number }): Promise<OccupancyView[]>;
  };
  /** The family's zones (docs/PLAN-WORLD-MODEL.md §8.4): places it knows that are no home — school, work — where presence says someone is. */
  zones: {
    /** By name; with those let go, `removed`. */
    list(options?: { removed?: boolean }): Promise<ZoneView[]>;
    add(input: ZoneInput): Promise<ZoneView>;
    update(id: string, changes: Partial<ZoneInput>): Promise<ZoneView>;
    /** Let go: archived, the stays there kept. */
    remove(id: string): Promise<ZoneView>;
  };
  /** A home's spaces (docs/PLAN-WORLD-MODEL.md §8.5): its site, buildings, floors, rooms, areas, the stairs, the outdoors. */
  spaces: {
    /** A home's, the site first and each after its parent; with those archived, `removed`. */
    list(homeId: string, options?: { removed?: boolean }): Promise<SpaceView[]>;
    add(input: SpaceInput): Promise<SpaceView>;
    update(id: string, changes: Partial<SpaceInput>): Promise<SpaceView>;
    /** Archived, with what is inside it: what stood there is history, and what stands there now moves out to its parent. Never the site. */
    remove(id: string): Promise<SpaceView>;
    /** What was read in it, and in the spaces inside it, by what stood there while it stood there: a room's temperature, whichever sensor it was. An archived one's too. */
    history(id: string, query: SpaceHistoryQuery): Promise<SpaceHistory>;
  };
  /** Where a home's spaces meet, or meet the outside: doors, stairs, windows. */
  openings: {
    list(homeId: string): Promise<OpeningView[]>;
    add(input: OpeningInput): Promise<OpeningView>;
    update(id: string, changes: Partial<OpeningInput>): Promise<OpeningView>;
    remove(id: string): Promise<OpeningView>;
  };
  /** Its people (docs/PLAN-WORLD-MODEL.md §8.2, §8.3): each as their own signed chain says, and what the family calls them. */
  people: {
    /** The members now, in the order they joined. */
    list(): Promise<PersonView[]>;
    /** Who asks, as this family knows them; null for one it does not. */
    me(): Promise<PersonView | null>;
    /** Who asks, as they prove it: their own chain, as this family keeps it — for a device come back with its recovery words. */
    myChain(): Promise<Statement[]>;
    /** The first person in an empty family founds it: its admin, its name, its first home. */
    found(input: FoundFamily): Promise<PersonView>;
    /** A newer copy of a person — oneself, or anyone by an admin — going on from the one kept. */
    present(chain: Statement[]): Promise<PersonView>;
    /** An admin's: a member's role — never the last admin's away — what the family calls them, their colour. */
    update(personId: string, changes: MemberChanges): Promise<PersonView>;
    /** An admin's: an invitation made, its secret answered this once. */
    invite(input: InvitationInput): Promise<InvitationMade>;
    /** An admin's: the invitations made, newest first. */
    invitations(): Promise<InvitationView[]>;
    /** An admin's: one who took an invitation that needs a yes, let in. */
    approve(invitationId: string): Promise<PersonView>;
    /** An admin's: an invitation taken back. */
    revokeInvitation(invitationId: string): Promise<InvitationView>;
    /**
     * A person forgotten (docs/PLAN-WORLD-MODEL.md §11.6) — oneself, or anyone
     * by an admin: they leave, their name becomes "Someone who left" here and
     * on the timeline, and their picture, keys, linked identities and
     * shortcuts go. Their id stays, so history adds up and points at no one.
     */
    erase(personId: string): Promise<void>;
    /**
     * What a person shares of where they are, and how long their stays are
     * kept (docs/PLAN-WORLD-MODEL.md §11): each adult their own; an admin a
     * child's. Paused — `pausedUntil` — it is off until then.
     */
    setSharing(personId: string, changes: SharingChanges): Promise<PersonView>;
  };
  /** A family's labels (docs/PLAN-WORLD-MODEL.md §8.13): any grouping it wants, on devices, spaces and automations. */
  labels: {
    list(): Promise<LabelView[]>;
    /** Which labels are on what. */
    labelled(): Promise<Labelled>;
    add(input: LabelInput): Promise<LabelView>;
    update(id: string, changes: Partial<LabelInput>): Promise<LabelView>;
    /** Gone, and off everything it was on. */
    remove(id: string): Promise<void>;
    /** One thing's labels, these and no others: the ones it has now, answered. */
    set(target: LabelTarget, labelIds: string[]): Promise<LabelView[]>;
  };
  /** Pictures, by their content (docs/PLAN-WORLD-MODEL.md §8.12): kept, then named by a home or a device. */
  media: {
    add(picture: NewMedia): Promise<MediaView>;
    /** Its bytes; null when it is not kept. */
    get(id: string): Promise<MediaData | null>;
  };
  /** The nodes of the home: its master, and every node that follows it. */
  nodes: {
    list(): Promise<NodeView[]>;
    /** A node joins the home — to follow it, and hold for it the ways it reaches — saying what it is, at every start. */
    join(node: NodeJoin): Promise<NodeView>;
    /** Forgotten, with every connection it held. Never the master. */
    forget(id: NodeId): Promise<void>;
  };
  /** What a node sends the master for a connection it holds (docs/DATA-MODEL.md §4): it speaks for its own connections and nobody else's. */
  held: {
    readings(device: SavedDeviceId, upload: HeldReadings): Promise<HeldReadingsTaken>;
    /** What the device keeps for its session, which the node holding it keeps a copy of for when it is offline. */
    store(device: SavedDeviceId): Promise<Record<string, unknown>>;
    keep(device: SavedDeviceId, key: string, entry: { nodeId: string; connectionId: string; value: unknown }): Promise<void>;
    /** What its gateway and sessions wrote on their timeline, queued while offline: the actor is always whoever is signed in. */
    audit(node: NodeId, entries: AuditUpload[]): Promise<{ recorded: number }>;
  };
  /**
   * What changed, as it changes: `hello` first, then what moved, coalesced —
   * read the list on `hello` and on `changed`, and apply the rest on top.
   * `draining`: whoever carries it says whether it can take more now; while
   * it cannot, the latest waits rather than a backlog. `onState`: told
   * whether it is up, as whoever carries it knows — a socket opening,
   * dropping and opening again; a home in the process is up at once.
   */
  live(listener: (update: LiveUpdate) => void, options?: { draining?: () => boolean; onState?: (state: LiveState) => void }): LiveStream;
}

/**
 * What is a server's own, not a home's (docs/PLAN-SHARED-CORE.md, principle
 * 4): whether one answers at an address, signing in, accounts, its version,
 * its log, its reset, and the copy of its configuration kept beside its
 * database. Over HTTP only: a home in an app has none of it.
 */
export interface ServerApi {
  /** Whether a kraftverk server answers here at all: what an address typed in is tried with. */
  probe(): Promise<boolean>;
  /** An invitation taken, with no session here yet: its secret, and who you are. */
  join(input: { invitation: string; secret: string; chain: Statement[]; sharing?: SharingLevel }): Promise<Joined>;
  auth: {
    /** Who is signed in, whether this network is trusted, and whether the first account is still to be made. */
    state(): Promise<AuthState>;
    /** The first account, from the home network only. */
    setup(username: string, password: string): Promise<Account>;
    logIn(username: string, password: string): Promise<Account>;
    /** Local development only: this computer signed in as the first account, with nothing typed — refused by a server not started for development. */
    dev(): Promise<Account>;
    logOut(): Promise<void>;
    /** Your own password: the current one too, and every other session ends. */
    changePassword(current: string, next: string): Promise<void>;
    /** A challenge for this device's key to answer: signing in with no password (docs/PLAN-WORLD-MODEL.md §10.5). */
    challenge(): Promise<Challenge>;
    /** Signed in by a key the family knows this person by. */
    signInWithKey(signIn: SignIn): Promise<Account>;
    /** Whose a key is, by its id: the person a recovery key's challenge is answered as. Null for a key no member holds. */
    holder(keyId: string): Promise<string | null>;
    /** The person a password signed in claimed by this device's account: the family knows them by its chain from now. */
    claim(chain: Statement[]): Promise<Account>;
  };
  /** Accounts: changing them takes your own password as well as your session. */
  accounts: {
    list(): Promise<AccountDetail[]>;
    add(username: string, password: string, yourPassword: string): Promise<AccountDetail>;
    remove(id: string, yourPassword: string): Promise<void>;
    setPassword(id: string, password: string, yourPassword: string): Promise<void>;
  };
  version(): Promise<VersionInfo>;
  /** What the server has said lately, and where its daily files are. */
  log(options?: { limit?: number; level?: ServerLogLine['level'] }): Promise<{ dir: string | null; lines: ServerLogLine[] }>;
  /** Emptying its database: whether it will — a passphrase in a file on it — and doing it. */
  reset: {
    available(): Promise<{ available: boolean; secretFile: string }>;
    run(secret: string): Promise<{ ok: true; tables: string[]; rows: number }>;
  };
  /**
   * The map it holds (docs/PLAN-MAPS.md): the world, and the regions
   * downloaded for detail — how big one would be, downloading it, getting it
   * afresh, letting it go.
   */
  map: {
    regions(): Promise<MapRegionsView>;
    estimate(ask: MapRegionAsk): Promise<{ bytes: number }>;
    add(ask: MapRegionAsk): Promise<MapRegionsView>;
    refresh(id: string): Promise<MapRegionsView>;
    remove(id: string): Promise<MapRegionsView>;
    /** Detail fetched as someone looks, on or off; and what was kept of it let go. */
    setFetching(on: boolean): Promise<MapRegionsView>;
    clearCache(): Promise<MapRegionsView>;
  };
  /** The configuration kept beside its database: where, when last written, and what the last restore did. */
  snapshot(): Promise<ConfigSnapshotView>;
  /** What importing the copy the last restore was made from would do, nothing written. */
  restoredPlan(mode: 'merge' | 'replace'): Promise<ImportPlan>;
}
