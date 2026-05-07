// sighborg-widget.js
// Scriptable iOS widget for Sigh-Borg (https://sigh-borg.com)
//
// Displays a random pun from the public Google Sheets CSV and deep-links
// back to the website via ?joke=INDEX so the site loads the same joke.
//
// Supported sizes: small · medium · large
// Install: paste into Scriptable, add a widget, set script name.

// --- CONSTANTS ----------------------------------------------------------------

const CSV_URL  = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRN5G-aBP45cQyt3m2Ojt5YDi7FdG56-vkmsftv5AnA4KoF17LzD9g1VtTKZOJRGX-HoukZCLxpkP4F/pub?output=csv";
const LOGO_URL = "https://sigh-borg.com/images/logo-sigh-borg.jpg";
const SITE_URL = "https://sigh-borg.com";

const CACHE_FILENAME = "sighborg_jokes_cache.json";
const LOGO_FILENAME  = "sighborg_logo.jpg";
const CACHE_TTL_MS   = 60 * 60 * 1000; // 1 hour
const MAX_JOKES      = 10000;           // memory safety cap

// --- COLORS -------------------------------------------------------------------

const COLOR_BG_TOP    = new Color("#e97e2c");
const COLOR_BG_BOTTOM = new Color("#D96A15");
const COLOR_SETUP     = new Color("#FAFAF8");
const COLOR_PUNCHLINE = new Color("#E8DCC8");
const COLOR_MUTED     = new Color("#E8DCC8", 0.5);
const COLOR_SEPARATOR = new Color("#FFFFFF", 0.2);

// --- FONT SIZES (pt) ---------------------------------------------------------

const FONT_SMALL_JOKE  = 12;
const FONT_MEDIUM_JOKE = 14;
const FONT_LARGE_JOKE  = 16;
const FONT_TITLE       = 17;
const FONT_SUBTITLE    = 13;
const FONT_FOOTER      = 10;

// --- LOGO DISPLAY SIZES (pt) -------------------------------------------------

const LOGO_SIZE_MEDIUM   = 32;
const LOGO_SIZE_LARGE    = 36;
const LOGO_RADIUS_MEDIUM = 6;
const LOGO_RADIUS_LARGE  = 8;

// --- FILE MANAGER -------------------------------------------------------------

// Always local — never iCloud — so caches survive without iCloud sign-in.
const fm = FileManager.local();

function cachePath(filename) {
  return fm.joinPath(fm.cacheDirectory(), filename);
}

// --- JOKES CACHE --------------------------------------------------------------

/**
 * Reads the jokes cache from disk.
 * Validates schema strictly — any malformation returns null rather than crashing.
 * Returns the jokes array only when valid *and* within TTL.
 */
function readJokesCache() {
  const path = cachePath(CACHE_FILENAME);
  if (!fm.fileExists(path)) return null;

  try {
    const data = JSON.parse(fm.readString(path));

    if (
      typeof data !== "object"       || data === null      ||
      !Array.isArray(data.jokes)     ||
      typeof data.timestamp !== "number"
    ) return null;

    if (Date.now() - data.timestamp >= CACHE_TTL_MS) return null;

    return data.jokes.length > 0 ? data.jokes : null;
  } catch {
    return null;
  }
}

/**
 * Same as readJokesCache() but ignores TTL.
 * Used as a last-resort fallback when a fresh fetch fails.
 */
function readStaleCacheAsFallback() {
  const path = cachePath(CACHE_FILENAME);
  if (!fm.fileExists(path)) return null;

  try {
    const data = JSON.parse(fm.readString(path));

    if (
      typeof data !== "object"       || data === null      ||
      !Array.isArray(data.jokes)     ||
      typeof data.timestamp !== "number"
    ) return null;

    return data.jokes.length > 0 ? data.jokes : null;
  } catch {
    return null;
  }
}

/** Persists the jokes array to disk. Non-fatal — widget still displays on failure. */
function writeJokesCache(jokes) {
  try {
    fm.writeString(
      cachePath(CACHE_FILENAME),
      JSON.stringify({ jokes, timestamp: Date.now() })
    );
  } catch {
    // Intentionally swallowed — caching is best-effort
  }
}

// --- LOGO CACHE ---------------------------------------------------------------

/**
 * Returns the logo Image object, reading from disk when already cached or
 * fetching and saving it on first use.
 * Returns null on any failure so callers can gracefully omit the logo.
 */
async function loadLogo() {
  const path = cachePath(LOGO_FILENAME);

  if (fm.fileExists(path)) {
    try {
      return fm.readImage(path);
    } catch {
      // Cached file unreadable — fall through to fetch
    }
  }

  try {
    const req = new Request(LOGO_URL);
    const img = await req.loadImage();
    try { fm.writeImage(path, img); } catch { /* non-fatal */ }
    return img;
  } catch {
    return null;
  }
}

// --- CSV FETCH & VALIDATION ---------------------------------------------------

/**
 * Fetches the raw CSV string from the Google Sheets endpoint.
 * Validates Content-Type (must contain text/csv or text/plain) and that the
 * body is a non-empty string.
 * Throws a descriptive Error on validation or network failure.
 */
async function fetchCSV() {
  const req    = new Request(CSV_URL);
  req.method   = "GET";
  req.headers  = { Accept: "text/csv, text/plain" };

  let body;
  try {
    body = await req.loadString();
  } catch (err) {
    throw new Error(`Network error fetching CSV: ${err.message}`);
  }

  // Guard against unexpected redirects or error pages
  const mimeType = (req.response?.mimeType ?? "").toLowerCase();
  if (mimeType && !mimeType.includes("text/csv") && !mimeType.includes("text/plain")) {
    throw new Error(`Unexpected Content-Type from CSV endpoint: "${mimeType}"`);
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    throw new Error("CSV endpoint returned an empty or non-string response body");
  }

  return body;
}

// --- CSV PARSING --------------------------------------------------------------

/**
 * Strips HTML tags and non-printable control characters from a joke string.
 * Preserves all printable Unicode so emoji and extended chars survive.
 */
function sanitizeJoke(text) {
  return text
    .replace(/<[^>]*>/g, "")                           // HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // C0 control chars (keep \t \n \r)
    .trim();
}

/**
 * Parses a raw CSV string into an array of clean joke strings.
 * - Skips blank lines
 * - Strips surrounding double-quotes per RFC 4180
 * - Unescapes doubled quotes ("") to a single quote (")
 * - Caps output at MAX_JOKES entries
 */
function parseCSV(csv) {
  const jokes = [];

  for (const rawLine of csv.split(/\r?\n/)) {
    if (jokes.length >= MAX_JOKES) break;

    let line = rawLine.trim();
    if (!line) continue;

    // RFC 4180 quoted field
    if (line.startsWith('"') && line.endsWith('"')) {
      line = line.slice(1, -1).replace(/""/g, '"');
    }

    const clean = sanitizeJoke(line);
    if (clean) jokes.push(clean);
  }

  return jokes;
}

// --- JOKE LOADING -------------------------------------------------------------

/**
 * Returns the full jokes array using this priority:
 *   1. Valid cache (within TTL)
 *   2. Fresh fetch — writes cache on success
 *   3. Stale cache as last resort when fetch fails
 *   4. Throws if all sources are unavailable
 */
async function loadJokes() {
  const cached = readJokesCache();
  if (cached) return cached;

  try {
    const csv   = await fetchCSV();
    const jokes = parseCSV(csv);

    if (jokes.length === 0) {
      throw new Error("CSV parsed successfully but contained no valid joke rows");
    }

    writeJokesCache(jokes);
    return jokes;
  } catch (fetchErr) {
    // Prefer showing a stale joke over the error screen
    const stale = readStaleCacheAsFallback();
    if (stale) return stale;

    throw new Error(
      `Failed to load jokes — network unavailable and no local cache exists. Reason: ${fetchErr.message}`
    );
  }
}

// --- JOKE PARSING -------------------------------------------------------------

/**
 * Splits a raw joke string into a structured object.
 * Priority order: ellipsis → question/answer → single line.
 *
 * Returns:
 *   { hasBreak: true,  setup: string, punchline: string }  — two-part joke
 *   { hasBreak: false, text:  string }                     — single-line joke
 */
function parseJoke(raw) {
  const text = raw.replace(/\.\.\.+/g, "…"); // normalise ... to ellipsis char

  // Priority 1: Ellipsis break — everything up to and including … is the setup
  const ellipsisIdx = text.indexOf("…");
  if (ellipsisIdx !== -1) {
    const setup     = text.slice(0, ellipsisIdx + 1);
    const punchline = text.slice(ellipsisIdx + 1).trim();
    if (punchline) return { hasBreak: true, setup, punchline };
  }

  // Priority 2: Question/answer — exclude quoted questions ("?") and ?… patterns
  const qMatch = text.match(/^(.+?\?)(\s+)(.+)$/);
  if (qMatch && !text.includes('?"') && !text.includes("?…")) {
    const setup     = qMatch[1].trim();
    const punchline = qMatch[3].trim();
    if (punchline) return { hasBreak: true, setup, punchline };
  }

  // Priority 3: Single line
  return { hasBreak: false, text };
}

// --- WIDGET HELPERS -----------------------------------------------------------

/** Applies the brand orange gradient (top → bottom) to the given widget. */
function applyGradient(widget) {
  const gradient     = new LinearGradient();
  gradient.colors    = [COLOR_BG_TOP, COLOR_BG_BOTTOM];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;
}

/**
 * Appends a thin 1pt horizontal separator to a vertically-laid-out parent.
 * size = new Size(0, 1): width 0 → stretches to fill; height 1 → 1pt tall.
 */
function addSeparator(parent) {
  const sep = parent.addStack();
  sep.size  = new Size(0, 1);
  sep.backgroundColor = COLOR_SEPARATOR;
  sep.addSpacer();
}

// --- SMALL WIDGET (≈ 155 × 155 pt) -------------------------------------------

/**
 * Both setup and punchline visible, 12pt, no logo.
 * Long jokes clip with ellipsis rather than hiding a line.
 */
function buildSmall(widget, joke) {
  applyGradient(widget);
  widget.setPadding(12, 12, 10, 12);

  const col = widget.addStack();
  col.layoutVertically();
  col.spacing = 4;

  if (joke.hasBreak) {
    const setup = col.addText(joke.setup);
    setup.font      = Font.boldSystemFont(FONT_SMALL_JOKE);
    setup.textColor = COLOR_SETUP;
    setup.lineLimit = 3;

    const punchline = col.addText(joke.punchline);
    punchline.font      = Font.systemFont(FONT_SMALL_JOKE);
    punchline.textColor = COLOR_PUNCHLINE;
    punchline.lineLimit = 3;
  } else {
    const jokeText = col.addText(joke.text);
    jokeText.font      = Font.systemFont(FONT_SMALL_JOKE);
    jokeText.textColor = COLOR_SETUP;
    jokeText.lineLimit = 6;
  }

  col.addSpacer();

  const footer = col.addText("sigh-borg.com");
  footer.font      = Font.systemFont(FONT_FOOTER);
  footer.textColor = COLOR_MUTED;
}

// --- MEDIUM WIDGET (≈ 329 × 155 pt) ------------------------------------------

/**
 * Joke left-aligned at 14pt bold/regular; logo pinned top-right at 32×32pt;
 * sigh-borg.com footer bottom-left.
 */
function buildMedium(widget, joke, logo) {
  applyGradient(widget);
  widget.setPadding(14, 14, 12, 14);

  // Top row: joke text (fills available width) + logo pinned right
  const topRow = widget.addStack();
  topRow.layoutHorizontally();
  topRow.spacing = 10;

  const jokeCol = topRow.addStack();
  jokeCol.layoutVertically();
  jokeCol.spacing = 5;

  if (joke.hasBreak) {
    const setup = jokeCol.addText(joke.setup);
    setup.font      = Font.boldSystemFont(FONT_MEDIUM_JOKE);
    setup.textColor = COLOR_SETUP;
    setup.lineLimit = 3;

    const punchline = jokeCol.addText(joke.punchline);
    punchline.font      = Font.systemFont(FONT_MEDIUM_JOKE);
    punchline.textColor = COLOR_PUNCHLINE;
    punchline.lineLimit = 3;
  } else {
    const jokeText = jokeCol.addText(joke.text);
    jokeText.font      = Font.systemFont(FONT_MEDIUM_JOKE);
    jokeText.textColor = COLOR_SETUP;
    jokeText.lineLimit = 5;
  }

  topRow.addSpacer();

  if (logo) {
    const img        = topRow.addImage(logo);
    img.imageSize    = new Size(LOGO_SIZE_MEDIUM, LOGO_SIZE_MEDIUM);
    img.cornerRadius = LOGO_RADIUS_MEDIUM;
  }

  widget.addSpacer();

  const footer = widget.addText("sigh-borg.com");
  footer.font      = Font.systemFont(FONT_FOOTER);
  footer.textColor = COLOR_MUTED;
}

// --- LARGE WIDGET (≈ 329 × 345 pt) -------------------------------------------

/**
 * Header row (logo + title + subtitle), separator, centered joke at 16pt,
 * separator, footer: "Tap for another groan · sigh-borg.com".
 */
function buildLarge(widget, joke, logo) {
  applyGradient(widget);
  widget.setPadding(16, 16, 14, 16);

  // -- Header ----------------------------------------------------------------
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  header.spacing = 10;

  if (logo) {
    const img        = header.addImage(logo);
    img.imageSize    = new Size(LOGO_SIZE_LARGE, LOGO_SIZE_LARGE);
    img.cornerRadius = LOGO_RADIUS_LARGE;
  }

  const titleCol = header.addStack();
  titleCol.layoutVertically();
  titleCol.spacing = 2;

  const title = titleCol.addText("Sigh-borg");
  title.font      = Font.boldSystemFont(FONT_TITLE);
  title.textColor = COLOR_SETUP;

  const subtitle = titleCol.addText("Your daily groan");
  subtitle.font      = Font.systemFont(FONT_SUBTITLE);
  subtitle.textColor = COLOR_MUTED;

  // -- First separator --------------------------------------------------------
  widget.addSpacer(10);
  addSeparator(widget);
  widget.addSpacer(); // flexible — centres joke vertically in remaining space

  // -- Joke content (centred) -------------------------------------------------
  if (joke.hasBreak) {
    const setup = widget.addText(joke.setup);
    setup.font      = Font.boldSystemFont(FONT_LARGE_JOKE);
    setup.textColor = COLOR_SETUP;
    setup.centerAlignText();
    setup.lineLimit = 4;

    widget.addSpacer(8);

    const punchline = widget.addText(joke.punchline);
    punchline.font      = Font.systemFont(FONT_LARGE_JOKE);
    punchline.textColor = COLOR_PUNCHLINE;
    punchline.centerAlignText();
    punchline.lineLimit = 4;
  } else {
    const jokeText = widget.addText(joke.text);
    jokeText.font      = Font.systemFont(FONT_LARGE_JOKE);
    jokeText.textColor = COLOR_SETUP;
    jokeText.centerAlignText();
    jokeText.lineLimit = 6;
  }

  // -- Second separator -------------------------------------------------------
  widget.addSpacer(); // flexible — pushes footer to bottom
  addSeparator(widget);
  widget.addSpacer(8);

  // -- Footer -----------------------------------------------------------------
  const footer = widget.addText("Tap for another groan · sigh-borg.com");
  footer.font      = Font.systemFont(FONT_FOOTER);
  footer.textColor = COLOR_MUTED;
  footer.centerAlignText();
}

// --- ERROR WIDGET -------------------------------------------------------------

/** Graceful error state on the brand background. Cannot crash. */
function buildError(widget) {
  applyGradient(widget);
  widget.setPadding(14, 14, 14, 14);

  const msg = widget.addText("Couldn't load a joke. Check your connection.");
  msg.font      = Font.systemFont(FONT_SMALL_JOKE);
  msg.textColor = COLOR_SETUP;
  msg.lineLimit = 4;
}

// --- MAIN ---------------------------------------------------------------------

async function run() {
  const widget = new ListWidget();

  // Default to medium when running inside the Scriptable app (not as a widget)
  const family = config.widgetFamily ?? "medium";

  // -- Load jokes ------------------------------------------------------------
  let jokes;
  try {
    jokes = await loadJokes();
  } catch {
    buildError(widget);
    Script.setWidget(widget);
    Script.complete();
    return;
  }

  // -- Select a random joke and record its 0-based index for the deep-link --
  const jokeIndex = Math.floor(Math.random() * jokes.length);
  const joke      = parseJoke(jokes[jokeIndex]);

  // Tapping the widget opens the site with the same joke pre-loaded
  widget.url = `${SITE_URL}?joke=${jokeIndex}`;

  // -- Logo is only needed for medium and large -------------------------------
  let logo = null;
  if (family === "medium" || family === "large") {
    logo = await loadLogo();
  }

  // -- Build the appropriate layout ------------------------------------------
  if (family === "small") {
    buildSmall(widget, joke);
  } else if (family === "medium") {
    buildMedium(widget, joke, logo);
  } else {
    buildLarge(widget, joke, logo);
  }

  Script.setWidget(widget);
  Script.complete();
}

await run();
