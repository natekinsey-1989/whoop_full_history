import { getValidAccessToken } from "./token.js";

const BASE = "https://api.prod.whoop.com/developer/v2";

// Official Whoop sport ID map — sourced from developer.whoop.com/docs/developing/user-data/workout/
// Note: sport_id is deprecated after 09/01/2025. Prefer sport_name from the workout record directly.
export const SPORT_MAP: Record<number, string> = {
  [-1]: "Activity",
  0:   "Running",
  1:   "Cycling",
  16:  "Baseball",
  17:  "Basketball",
  18:  "Rowing",
  19:  "Fencing",
  20:  "Field Hockey",
  21:  "Football",
  22:  "Golf",
  24:  "Ice Hockey",
  25:  "Lacrosse",
  27:  "Rugby",
  28:  "Sailing",
  29:  "Skiing",
  30:  "Soccer",
  31:  "Softball",
  32:  "Squash",
  33:  "Swimming",
  34:  "Tennis",
  35:  "Track & Field",
  36:  "Volleyball",
  37:  "Water Polo",
  38:  "Wrestling",
  39:  "Boxing",
  42:  "Dance",
  43:  "Pilates",
  44:  "Yoga",
  45:  "Weightlifting",
  47:  "Cross Country Skiing",
  48:  "Functional Fitness",
  49:  "Duathlon",
  51:  "Gymnastics",
  52:  "Hiking/Rucking",
  53:  "Horseback Riding",
  55:  "Kayaking",
  56:  "Martial Arts",
  57:  "Mountain Biking",
  59:  "Powerlifting",
  60:  "Rock Climbing",
  61:  "Paddleboarding",
  62:  "Triathlon",
  63:  "Walking",
  64:  "Surfing",
  65:  "Elliptical",
  66:  "Stairmaster",
  70:  "Meditation",
  71:  "Hot Shower",
  73:  "Diving",
  74:  "Operations - Tactical",
  75:  "Operations - Medical",
  76:  "Operations - Flying",
  77:  "Operations - Water",
  82:  "Ultimate",
  83:  "Climber",
  84:  "Jumping Rope",
  85:  "Australian Football",
  86:  "Skateboarding",
  87:  "Coaching",
  88:  "Ice Bath",
  89:  "Commuting",
  90:  "Gaming",
  91:  "Snowboarding",
  92:  "Motocross",
  93:  "Caddying",
  94:  "Obstacle Course Racing",
  95:  "Motor Racing",
  96:  "HIIT",
  97:  "Spin",
  98:  "Jiu Jitsu",
  99:  "Manual Labor",
  100: "Cricket",
  101: "Pickleball",
  102: "Inline Skating",
  103: "Box Fitness",
  104: "Spikeball",
  105: "Wheelchair Pushing",
  106: "Paddle Tennis",
  107: "Barre",
  108: "Stage Performance",
  109: "High Stress Work",
  110: "Parkour",
  111: "Gaelic Football",
  112: "Hurling/Camogie",
  113: "Circus Arts",
  121: "Massage Therapy",
  123: "Strength Trainer",
  125: "Watching Sports",
  126: "Assault Bike",
  127: "Kickboxing",
  128: "Stretching",
  230: "Table Tennis",
  231: "Badminton",
  232: "Netball",
  233: "Sauna",
  234: "Disc Golf",
  235: "Yard Work",
  236: "Air Compression",
  237: "Percussive Massage",
  238: "Paintball",
  239: "Ice Skating",
  240: "Handball",
  248: "F45 Training",
  249: "Padel",
  250: "Barry's",
  251: "Dedicated Parenting",
  252: "Stroller Walking",
  253: "Stroller Jogging",
  254: "Toddlerwearing",
  255: "Babywearing",
  258: "Barre3",
  259: "Hot Yoga",
  261: "Stadium Steps",
  262: "Polo",
  263: "Musical Performance",
  264: "Kite Boarding",
  266: "Dog Walking",
  267: "Water Skiing",
  268: "Wakeboarding",
  269: "Cooking",
  270: "Cleaning",
  272: "Public Speaking",
  275: "Driving",
  // ── Add new IDs here as Whoop expands the sport list ──────────────────────
  // HOT SHOWER: add the Whoop-assigned sport ID here once confirmed, e.g.:
  // XXX: "Hot Shower",
};

interface PagedResponse<T> {
  records: T[];
  next_token: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HTTP with retry ──────────────────────────────────────────────────────────

async function getWithRetry<T>(path: string, attempt = 0): Promise<T> {
  const token = await getValidAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    const waitMs = Math.max(retryAfter * 1000, 1000) * Math.pow(2, attempt);
    console.log(`[whoop] 429 rate limit on ${path}, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
    await sleep(waitMs);
    if (attempt < 5) return getWithRetry<T>(path, attempt + 1);
    throw new Error(`Rate limit exceeded after 5 retries on ${path}`);
  }

  if (!res.ok) {
    throw new Error(`Whoop API ${res.status} on ${path}: ${await res.text()}`);
  }

  return res.json() as Promise<T>;
}

// ─── Paginated fetch ──────────────────────────────────────────────────────────
// start/end are YYYY-MM-DD strings. When provided they are passed to the
// Whoop API as start and end query params so only the requested window is
// fetched — avoiding a full history scan for small incremental syncs.

export async function fetchAllPages<T>(
  endpoint: string,
  opts: { start?: string; end?: string; onPage?: (count: number) => void } = {}
): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | null = null;
  let page = 0;

  do {
    const params = new URLSearchParams({ limit: "25" });
    if (nextToken)  params.set("nextToken", nextToken);
    // Whoop API accepts start/end as ISO datetime strings
    if (opts.start) params.set("start", `${opts.start}T00:00:00.000Z`);
    if (opts.end)   params.set("end",   `${opts.end}T23:59:59.999Z`);

    const data = await getWithRetry<PagedResponse<T>>(`${endpoint}?${params.toString()}`);
    all.push(...data.records);
    nextToken = data.next_token;
    page++;

    if (opts.onPage) opts.onPage(all.length);
    if (nextToken) await sleep(500); // polite delay between pages
  } while (nextToken);

  console.log(`[whoop] ${endpoint}: fetched ${all.length} records in ${page} pages`);
  return all;
}

// ─── Profile / body ───────────────────────────────────────────────────────────

export async function fetchProfile(): Promise<Record<string, unknown>> {
  return getWithRetry<Record<string, unknown>>("/user/profile/basic");
}

export async function fetchBody(): Promise<Record<string, unknown>> {
  return getWithRetry<Record<string, unknown>>("/user/measurement/body");
}
