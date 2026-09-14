const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';

/**
 * This console output doubles as the copy-paste support channel described in the Epic 10
 * brainstorming — it must degrade to clean plain text (no raw escape codes) whenever it isn't
 * rendered by a real terminal (piped to a file, redirected) or when the user has explicitly opted
 * out via NO_COLOR (https://no-color.org — disabling is keyed on the variable's mere *presence*,
 * not its value, so `NO_COLOR=` with an empty value still disables color). Read live rather than
 * cached at module load, so tests can toggle it without import-order tricks. Gated on the stream
 * this particular line actually writes to: `printStepFailed`/`printWarning` go to stderr, so
 * `node main.js 2>log.txt` in a real terminal must not leak escape codes into that file, and
 * `node main.js >log.txt` (stdout redirected, stderr still a terminal) must not strip color from
 * output that's still going to a real terminal.
 */
function colorEnabled(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY === true && process.env['NO_COLOR'] === undefined;
}

function paint(stream: NodeJS.WriteStream, code: string, text: string): string {
  return colorEnabled(stream) ? `${code}${text}${RESET}` : text;
}

/** A bordered startup banner — printed once, first thing the user sees. */
export function printBanner(version: string): void {
  const title = `MyRailDepot Bridge  v${version}`;
  const width = title.length + 4;
  const pad = width - title.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(paint(process.stdout, BLUE + BOLD, `╔${'═'.repeat(width)}╗`));
  console.log(paint(process.stdout, BLUE + BOLD, `║${' '.repeat(left)}${title}${' '.repeat(right)}║`));
  console.log(paint(process.stdout, BLUE + BOLD, `╚${'═'.repeat(width)}╝`));
}

/** "▶ <label>…" — call before starting a step; pair with printStepDone/printStepFailed. */
export function printStep(label: string): void {
  console.log(`${paint(process.stdout, DIM, '▶')} ${label}…`);
}

/** "✓ <label>" — call when a step announced via printStep succeeds. */
export function printStepDone(label: string): void {
  console.log(`${paint(process.stdout, GREEN, '✓')} ${label}`);
}

/** "✗ <label>: <detail>" — call when a step announced via printStep fails. Writes to stderr. */
export function printStepFailed(label: string, detail: string): void {
  console.error(`${paint(process.stderr, RED, '✗')} ${label}: ${detail}`);
}

/** A plain informational line — dimmed, no icon. */
export function printInfo(message: string): void {
  console.log(paint(process.stdout, DIM, message));
}

/** A warning that doesn't stop anything (e.g. a background update failed) — yellow, not red. Writes to stderr. */
export function printWarning(message: string): void {
  console.warn(`${paint(process.stderr, YELLOW, '⚠')} ${message}`);
}
