/**
 * The playground wiring.
 *
 * Nothing here knows how the mascot moves. It sets states and aims the gaze —
 * the same surface a product screen will use.
 */

import { STATES, createMascot, type Mascot, type MascotState } from "@rp/mascot";

/** What each state is, and why it looks the way it does. */
const STATE: Record<MascotState, { note: string; line: string; why: string }> = {
  idle: {
    note: "ambient",
    line: "Watching quietly.",
    why: "The ghost, as drawn. At rest the character is the brand icon and has nothing to say, so it breathes, sways, and lets its head drift slowly, the way attention does.",
  },
  thinking: {
    note: "weighing",
    line: "Weighing the options.",
    why: "A circle with the headband turning slowly round it: the knot and tails go round the back and come out the other side, over and over, while the head sways with the turn and the eyes look up and follow. Machinery turning inside the head.",
  },
  loading: {
    note: "in progress",
    line: "Working through it.",
    why: "A cycle: on a fixed beat the shape jumps to the next one — triangle, square, bar, play. Work in progress is change without arrival. No spinner, because the character never rotates.",
  },
  success: {
    note: "done",
    line: "That moved up.",
    why: "A diamond hopping for joy: a steady hop the whole time, a stretch in the air and a press on landing, the head wiggling with it, and a wink once in a while.",
  },
  error: {
    note: "recover",
    line: "That did not land.",
    why: "An exclamation mark that arrives shaking its head no. Once a cycle the mark is thumped — the bar drops, the point swells, the head shakes no — and the band goes amber.",
  },
};

const need = <T extends Element>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`The playground is missing ${selector}.`);
  return node;
};

const portrait = need<HTMLDivElement>("#portrait");
const voice = need<HTMLElement>("#voice");
const readout = need<HTMLElement>("#readout");
const stateRows = need<HTMLDivElement>("#stateRows");
const followPointer = need<HTMLInputElement>("#followPointer");
const showTile = need<HTMLInputElement>("#showTile");
const reduceMotion = need<HTMLInputElement>("#reduceMotion");

let mascot: Mascot = build();
const cells: Cell[] = [];

/** Rebuild the rig when a construction option changes, keeping the live state. */
function build(state: MascotState = "idle"): Mascot {
  portrait.replaceChildren();
  portrait.classList.toggle("tile", showTile.checked);
  return createMascot(portrait, {
    tile: showTile.checked,
    state,
    reducedMotion: reduceMotion.checked ? true : undefined,
    label: null,
  });
}

function describe(): void {
  const motion = mascot.reducedMotion ? "reduced motion" : "motion on";
  readout.innerHTML = `State <strong>${mascot.state}</strong> · ${motion}`;
}

function select(state: MascotState): void {
  mascot.setState(state);
  voice.textContent = STATE[state].line;
  for (const row of stateRows.querySelectorAll<HTMLButtonElement>(".row")) {
    row.setAttribute("aria-pressed", String(row.dataset.state === state));
  }
  describe();
}

for (const state of STATES) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "row";
  row.dataset.state = state;
  row.setAttribute("aria-pressed", String(state === mascot.state));
  row.innerHTML = `<span>${state}</span><span>${STATE[state].note}</span>`;
  row.addEventListener("click", () => select(state));
  stateRows.append(row);
}

need<HTMLButtonElement>("#blink").addEventListener("click", () => mascot.blink());
need<HTMLButtonElement>("#release").addEventListener("click", () => mascot.releaseGaze());

followPointer.addEventListener("change", () => {
  if (!followPointer.checked) mascot.releaseGaze();
});

showTile.addEventListener("change", () => {
  const state = mascot.state;
  mascot.destroy();
  mascot = build(state);
  select(state);
});

reduceMotion.addEventListener("change", () => {
  mascot.setReducedMotion(reduceMotion.checked ? true : null);
  describe();
});

// Gaze follows the pointer only while it is over the page — never off-screen.
document.addEventListener("pointermove", (event) => {
  if (!followPointer.checked) return;
  mascot.lookAtPoint(event.clientX, event.clientY);
});
document.addEventListener("pointerleave", () => mascot.releaseGaze());

describe();

// ---------------------------------------------------------------- turn tests

/**
 * Turn tests. Every mascot on the page takes the same yaw, so the illusion can
 * be judged on every silhouette at once.
 */
const turnYaw = need<HTMLInputElement>("#turnYaw");
const turnYawValue = need<HTMLElement>("#turnYawValue");
let turnTest = 0;

const everyone = (): Mascot[] => [mascot, ...cells.map((cell) => cell.mascot)];

function yawAll(yaw: number): void {
  turnYaw.value = String(Math.round(yaw * 100));
  turnYawValue.textContent = yaw.toFixed(2);
  for (const each of everyone()) each.turnHead(yaw);
}

function releaseAll(): void {
  window.cancelAnimationFrame(turnTest);
  turnTest = 0;
  turnYaw.value = "0";
  turnYawValue.textContent = "0.00";
  for (const each of everyone()) each.releaseTurn();
}

/** Drive the yaw along a curve for `duration` ms, then leave it where the curve ends. */
function drive(curve: (t: number) => number, duration: number, then?: () => void): void {
  window.cancelAnimationFrame(turnTest);
  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / duration);
    yawAll(curve(t));
    if (t < 1) turnTest = window.requestAnimationFrame(step);
    else { turnTest = 0; then?.(); }
  };
  turnTest = window.requestAnimationFrame(step);
}

const TURN_TESTS: Record<string, () => void> = {
  // A slow full sweep, left to right and back, for ever.
  sweep: () => {
    const loop = (): void => drive((t) => Math.sin(t * Math.PI * 2) * 0.9, 4000, loop);
    loop();
  },
  // A quick "no": three swings and home.
  shake: () => drive((t) => Math.sin(t * Math.PI * 3) * 0.7 * (1 - t), 700, releaseAll),
  // Look one way, hold, look the other way, hold, come home.
  peek: () =>
    drive(
      (t) => (t < 0.45 ? -0.85 : t < 0.55 ? 0 : t < 0.95 ? 0.85 : 0),
      3200,
      releaseAll,
    ),
  release: releaseAll,
};

turnYaw.addEventListener("input", () => {
  window.cancelAnimationFrame(turnTest);
  turnTest = 0;
  yawAll(Number(turnYaw.value) / 100);
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-turn-test]")) {
  button.addEventListener("click", () => TURN_TESTS[button.dataset.turnTest!]?.());
}

// ---------------------------------------------------------------- the grid

/**
 * One cell per state, each holding its state.
 *
 * Judging a state one button press at a time is slow and unreliable — a
 * change that helps the dots can quietly ruin the check mark. Here every
 * state runs side by side on the same clock. The loop drops every cell back
 * to idle and returns it, so the arrivals can be compared too.
 */
const grid = need<HTMLDivElement>("#silhouetteGrid");
const gridLoop = need<HTMLInputElement>("#gridLoop");
const gridDwell = need<HTMLInputElement>("#gridDwell");
const gridDwellValue = need<HTMLElement>("#gridDwellValue");
const gridStep = need<HTMLButtonElement>("#gridStep");

interface Cell {
  readonly state: MascotState;
  readonly mascot: Mascot;
  readonly root: HTMLElement;
}

for (const state of STATES) {
  const cell = document.createElement("figure");
  cell.className = "grid-cell active";
  cell.innerHTML = `<div class="frame"></div><figcaption><strong>${state}</strong><span class="why">${STATE[state].why}</span></figcaption>`;
  grid.append(cell);
  cells.push({
    state,
    mascot: createMascot(cell.querySelector<HTMLDivElement>(".frame")!, {
      tile: true,
      state,
      label: null,
    }),
    root: cell,
  });
}

let showingStates = true;

/** Every cell to idle, or every cell back to its own state. */
function stepGrid(): void {
  showingStates = !showingStates;
  for (const cell of cells) {
    cell.mascot.setState(showingStates ? cell.state : "idle");
    cell.root.classList.toggle("active", showingStates);
  }
}

/** Send every cell to idle and straight back, so all five arrivals play at once. */
function reenter(): void {
  for (const cell of cells) cell.mascot.setState("idle");
  window.setTimeout(() => {
    for (const cell of cells) cell.mascot.setState(cell.state);
  }, 700);
  showingStates = true;
  for (const cell of cells) cell.root.classList.add("active");
}

let gridTimer = 0;

function scheduleGrid(): void {
  window.clearTimeout(gridTimer);
  if (!gridLoop.checked) {
    if (!showingStates) stepGrid();
    return;
  }
  gridTimer = window.setTimeout(() => {
    stepGrid();
    scheduleGrid();
  }, Number(gridDwell.value));
}

gridLoop.addEventListener("change", scheduleGrid);
gridDwell.addEventListener("input", () => {
  gridDwellValue.textContent = `${gridDwell.value}ms`;
  scheduleGrid();
});
gridStep.addEventListener("click", reenter);
scheduleGrid();
