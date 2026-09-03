/**
 * A fake DOM, only as large as the rig needs.
 *
 * `createMascot` is the one layer of this package that a pure test cannot
 * reach: it builds an SVG, reads its own markup back, and drives it from a
 * frame loop. Bun has no DOM, so this file supplies the smallest one that runs
 * the real `Runtime` unchanged.
 *
 * **This is not a browser.** It is a test double, and every claim a test makes
 * on it has to be a claim about the rig, never about the DOM. What is missing:
 *
 * - No layout, no CSS cascade, and no rendering. `style` is a plain bag of
 *   strings and `getBoundingClientRect` returns whatever the test put there.
 * - No clipping and no masking. The clip and mask paths are stored like any
 *   other attribute, so geometry that the browser would trim is still readable
 *   here. That is why the tile-margin measurement excludes the band.
 * - `innerHTML` parses the rig's own markup and nothing else: paired or
 *   self-closing tags, double-quoted attributes, no entities, no comments, no
 *   text nodes. It is a reader for `rigMarkup`, not an HTML parser.
 * - One simple selector per query: `#id`, `.class`, or a tag name. No
 *   combinators, no attribute selectors.
 * - Events do not bubble and have no phases. A listener is a callback in a set.
 * - The clock is virtual. Nothing runs until `advance` is called, so a test
 *   says how much of a second it wants and gets exactly that.
 *
 * `Math.random` is replaced by a seeded generator, because the blink schedule
 * reads it; `globalThis.CSS` is installed, because `readParts` calls
 * `CSS.escape`. `restore()` puts both back and every test has to call it.
 */

/** Virtual milliseconds between animation frames: 60 fps, the rate the rig assumes. */
export const FRAME_MS = 1000 / 60;

// ------------------------------------------------------------------- clock

/**
 * The clock, the frame pump, and the timer queue.
 *
 * Time only moves in `advance`, and it moves to the next thing that is due —
 * a timer at its exact millisecond, a frame at the next 60 fps boundary — so
 * a run of frames is the same run every time.
 */
export class FakeClock {
  now = 0;

  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private readonly frames = new Map<number, (now: number) => void>();
  private lastPump = 0;

  get pendingTimeouts(): number {
    return this.timers.size;
  }

  get pendingFrames(): number {
    return this.frames.size;
  }

  setTimeout(run: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, ms), run });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  requestAnimationFrame(callback: (now: number) => void): number {
    // The first request after a quiet spell starts a new cadence, so the frame
    // lands about 16 ms later rather than at once.
    if (this.frames.size === 0) this.lastPump = this.now;
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }

  /** Run everything that falls due in the next `ms` milliseconds. */
  advance(ms: number): void {
    const end = this.now + ms;
    // A timer that reschedules itself with a zero gap would spin here; a run
    // of a minute is about 3600 steps, so this is far above any real use.
    let guard = 0;
    while (this.now < end - 1e-9) {
      if (++guard > 500_000) throw new Error("The fake clock stopped making progress.");
      const nextFrame = this.frames.size === 0 ? Infinity : this.lastPump + FRAME_MS;
      let nextTimer = Infinity;
      for (const timer of this.timers.values()) if (timer.at < nextTimer) nextTimer = timer.at;
      this.now = Math.max(this.now, Math.min(nextFrame, nextTimer, end));

      // Timers first, then the frame: a browser runs its timer queue before it
      // paints, and a beat scheduled for this millisecond has to be visible in
      // the frame that follows it.
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= this.now + 1e-9)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) if (this.timers.delete(id)) timer.run();

      if (this.frames.size > 0 && this.now >= nextFrame - 1e-9) {
        this.lastPump = this.now;
        const pending = [...this.frames.values()];
        this.frames.clear();
        for (const callback of pending) callback(this.now);
      }
    }
  }
}

// ---------------------------------------------------------------- elements

export interface FakeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The box every element reports until a test gives it another one. */
const DEFAULT_BOX: FakeBox = { left: 0, top: 0, width: 256, height: 256 };

function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** One element. The rig draws into paths, groups, and one circle; all of them are this. */
export class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string>;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  textContent = "";
  /** What `getBoundingClientRect` reports. A test that measures pixels sets this. */
  box: FakeBox = { ...DEFAULT_BOX };

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    this.dataset = new Proxy(
      {},
      {
        get: (_, key: string) => this.attributes.get(`data-${camelToKebab(key)}`),
        set: (_, key: string, value: string) => {
          this.attributes.set(`data-${camelToKebab(key)}`, String(value));
          return true;
        },
      },
    ) as Record<string, string>;
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  set id(value: string) {
    this.attributes.set("id", value);
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  get classList(): {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
  } {
    const names = (): string[] => this.className.split(/\s+/).filter((name) => name.length > 0);
    const write = (list: readonly string[]): void => void this.attributes.set("class", list.join(" "));
    return {
      add: (name) => {
        if (!names().includes(name)) write([...names(), name]);
      },
      remove: (name) => write(names().filter((held) => held !== name)),
      contains: (name) => names().includes(name),
    };
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): FakeBox & { right: number; bottom: number } {
    return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height };
  }

  set innerHTML(markup: string) {
    this.children = [];
    parseInto(this, markup);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }

  before(node: FakeElement): void {
    this.insert(node, 0);
  }

  after(node: FakeElement): void {
    this.insert(node, 1);
  }

  private insert(node: FakeElement, offset: number): void {
    const parent = this.parentNode;
    if (parent === null) throw new Error("A detached element has no siblings.");
    node.remove();
    node.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + offset, 0, node);
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
  }

  /** Descendants in document order. The element itself is not one of them. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector: string): boolean {
    // `readParts` runs its ids through `CSS.escape`, so a selector may carry
    // backslashes that the id itself does not.
    const plain = selector.replace(/\\/g, "");
    if (plain.startsWith("#")) return this.id === plain.slice(1);
    if (plain.startsWith(".")) return this.classList.contains(plain.slice(1));
    return this.tagName.toLowerCase() === plain.toLowerCase();
  }

  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((node) => node.matches(selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((node) => node.matches(selector));
  }
}

// ----------------------------------------------------------------- parsing

const TAG = /<\s*(\/)?\s*([A-Za-z][-\w:]*)((?:\s+[-\w:]+\s*=\s*"[^"]*")*)\s*(\/)?>/g;
const ATTRIBUTE = /([-\w:]+)\s*=\s*"([^"]*)"/g;

/**
 * Read the rig's markup into `root`.
 *
 * Enough of a parser for `rigMarkup` and no more: tags with double-quoted
 * attributes, either paired or self-closing. Anything between tags is dropped,
 * which for this markup is whitespace.
 */
function parseInto(root: FakeElement, markup: string): void {
  const stack: FakeElement[] = [root];
  for (const match of markup.matchAll(TAG)) {
    const [, closing, name, attributes, selfClosing] = match;
    const parent = stack[stack.length - 1]!;
    if (closing !== undefined) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const element = new FakeElement(name!, root.ownerDocument);
    for (const attribute of (attributes ?? "").matchAll(ATTRIBUTE)) {
      element.setAttribute(attribute[1]!, attribute[2]!);
    }
    parent.append(element);
    if (selfClosing === undefined) stack.push(element);
  }
}

// ------------------------------------------------------------- media query

type Listener = () => void;

/** A `prefers-reduced-motion` query the test controls. */
export class FakeMediaQueryList {
  matches = false;
  private readonly listeners = new Set<Listener>();

  constructor(readonly media: string) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "change") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "change") this.listeners.delete(listener);
  }

  set(matches: boolean): void {
    if (matches === this.matches) return;
    this.matches = matches;
    for (const listener of [...this.listeners]) listener();
  }
}

// ---------------------------------------------------------------- document

export class FakeDocument {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  hidden = false;
  defaultView!: FakeWindow;

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.head, this.body);
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

// ------------------------------------------------------------------ window

export class FakeWindow {
  readonly performance: { now: () => number };
  private readonly queries = new Map<string, FakeMediaQueryList>();

  constructor(
    readonly document: FakeDocument,
    readonly clock: FakeClock,
  ) {
    this.performance = { now: () => this.clock.now };
  }

  /** The same query string always returns the same list, as a browser does. */
  matchMedia(media: string): FakeMediaQueryList {
    const held = this.queries.get(media);
    if (held !== undefined) return held;
    const query = new FakeMediaQueryList(media);
    this.queries.set(media, query);
    return query;
  }

  setTimeout(run: () => void, ms: number): number {
    return this.clock.setTimeout(run, ms);
  }

  clearTimeout(id: number): void {
    this.clock.clearTimeout(id);
  }

  requestAnimationFrame(callback: (now: number) => void): number {
    return this.clock.requestAnimationFrame(callback);
  }

  cancelAnimationFrame(id: number): void {
    this.clock.cancelAnimationFrame(id);
  }
}

// ------------------------------------------------------------------ handle

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** A tiny deterministic generator, so the blink schedule is the same every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeDom {
  readonly document: FakeDocument;
  readonly window: FakeWindow;
  readonly clock: FakeClock;
  /** The element a mascot is built into, already typed for `createMascot`. */
  readonly host: HTMLElement;
  readonly reducedMotionQuery: FakeMediaQueryList;
  /** Run `ms` of virtual time: every frame and every timer that falls due in it. */
  advance: (ms: number) => void;
  /** Answer `prefers-reduced-motion` differently, and tell the listeners. */
  reduceMotion: (on: boolean) => void;
  /** Hide or show the document, and tell the listeners. */
  hide: (hidden: boolean) => void;
  /** What is still held: nothing should be, once a mascot is destroyed. */
  readonly pending: {
    readonly frames: number;
    readonly timeouts: number;
    readonly mediaListeners: number;
    readonly documentListeners: number;
  };
  /** Put back the real `Math.random` and whatever `CSS` was there before. */
  restore: () => void;
}

export interface FakeDomOptions {
  /** The seed for the stand-in `Math.random`. The same seed gives the same blinks. */
  readonly seed?: number;
}

export function createFakeDom(options: FakeDomOptions = {}): FakeDom {
  const clock = new FakeClock();
  const document = new FakeDocument();
  const window = new FakeWindow(document, clock);
  document.defaultView = window;

  const host = document.createElement("div");
  document.body.append(host);

  const globals = globalThis as { CSS?: unknown };
  const heldCss = globals.CSS;
  // `readParts` escapes every id it looks up. The rig's ids are plain
  // identifiers, so this only has to be safe, not complete.
  globals.CSS = { escape: (value: string) => value.replace(/([^\w-])/g, "\\$1") };

  const heldRandom = Math.random;
  Math.random = mulberry32(options.seed ?? 1);

  const reducedMotionQuery = window.matchMedia(REDUCED_MOTION);

  return {
    document,
    window,
    clock,
    host: host as unknown as HTMLElement,
    reducedMotionQuery,
    advance: (ms) => clock.advance(ms),
    reduceMotion: (on) => reducedMotionQuery.set(on),
    hide: (hidden) => {
      if (document.hidden === hidden) return;
      document.hidden = hidden;
      document.dispatch("visibilitychange");
    },
    get pending() {
      return {
        frames: clock.pendingFrames,
        timeouts: clock.pendingTimeouts,
        mediaListeners: reducedMotionQuery.listenerCount,
        documentListeners: document.listenerCount,
      };
    },
    restore: () => {
      Math.random = heldRandom;
      globals.CSS = heldCss;
    },
  };
}

// ----------------------------------------------------------------- reading

/** The fake behind an element the rig handed back as a DOM type. */
export function fakeOf(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) throw new Error("That is not an element of the fake DOM.");
  return node;
}

/** One part of a drawn rig, by class or by id. Missing is a defect, not a null. */
export function query(root: unknown, selector: string): FakeElement {
  const found = fakeOf(root).querySelector(selector);
  if (found === null) throw new Error(`The rig has no "${selector}".`);
  return found;
}

export function queryAll(root: unknown, selector: string): FakeElement[] {
  return fakeOf(root).querySelectorAll(selector);
}
