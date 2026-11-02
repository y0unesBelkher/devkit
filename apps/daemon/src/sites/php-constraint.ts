// A small Composer version-constraint matcher, enough for `require.php` ("^8.2", ">=8.1 <8.4", "^8.1|^8.2", "8.3.*").

type Version = [number, number, number];
type Check = (v: Version) => boolean;

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

interface Parsed {
  version: Version;
  /** How many leading parts were given before a wildcard or the end ("8.2" → 2). */
  parts: number;
  wildcard: boolean;
}

function parseVersion(text: string): Parsed | null {
  const match = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:\.\d+)?(?:-[\w.]+)?$/i.exec(text);
  if (!match) return null;
  const raw = [match[1], match[2], match[3]];
  const version: Version = [0, 0, 0];
  let parts = 0;
  let wildcard = false;
  for (const part of raw) {
    if (part === undefined) break;
    if (/^[x*]$/i.test(part)) {
      wildcard = true;
      break;
    }
    version[parts] = Number(part);
    parts++;
  }
  return { version, parts, wildcard };
}

const bump = (v: Version, index: number): Version =>
  index === 0 ? [v[0] + 1, 0, 0] : index === 1 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1];

function range(min: Version, maxExclusive: Version | null): Check {
  return (v) => cmp(v, min) >= 0 && (maxExclusive === null || cmp(v, maxExclusive) < 0);
}

function parseAtom(atom: string): Check | null {
  if (atom === '*' || atom === '') return () => true;
  const match = /^(\^|~|>=|<=|>|<|!=|==?)?(.+)$/.exec(atom);
  if (!match) return null;
  const op = match[1] ?? '';
  const parsed = parseVersion(match[2]!);
  if (!parsed) return null;
  const { version: v, parts, wildcard } = parsed;
  if (parts === 0) return () => true;

  switch (op) {
    case '^':
      // ^0.x pins the minor; PHP is never 0.x, but keep Composer's meaning.
      return range(v, v[0] > 0 ? bump(v, 0) : bump(v, Math.min(parts - 1, 1)));
    case '~':
      return range(v, bump(v, Math.max(parts - 2, 0)));
    case '>=':
      return (x) => cmp(x, v) >= 0;
    case '>':
      return (x) => cmp(x, v) > 0;
    case '<=':
      return (x) => cmp(x, v) <= 0;
    case '<':
      return (x) => cmp(x, v) < 0;
    case '!=':
      return (x) => cmp(x, v) !== 0;
    default:
      // "8.3.*" or "8.3": every release with that prefix.
      return wildcard || parts < 3 ? range(v, bump(v, parts - 1)) : (x) => cmp(x, v) === 0;
  }
}

/** Compiles a constraint; returns null when it cannot be understood (callers then don't filter). */
export function compileConstraint(constraint: string): Check | null {
  const cleaned = constraint.replace(/@\w+/g, '').replace(/(\^|~|>=|<=|>|<|!=|==?)\s+/g, '$1').trim();
  if (!cleaned) return null;
  const alternatives: Check[] = [];
  for (const alternative of cleaned.split(/\s*\|\|?\s*/)) {
    const checks: Check[] = [];
    for (const atom of alternative.split(/\s*,\s*|\s+/).filter(Boolean)) {
      const check = parseAtom(atom);
      if (!check) return null;
      checks.push(check);
    }
    alternatives.push((v) => checks.every((check) => check(v)));
  }
  return (v) => alternatives.some((check) => check(v));
}

/** True when the full version "X.Y.Z" satisfies the constraint (npm-style ranges work too). */
export function versionSatisfies(constraint: string, version: string): boolean {
  const check = compileConstraint(constraint);
  if (!check) return true;
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return check([major, minor, patch]);
}

/** True when some release of minor version "X.Y" satisfies the constraint. */
export function minorSatisfies(constraint: string, minor: string): boolean {
  const check = compileConstraint(constraint);
  if (!check) return true;
  const [major, min] = minor.split('.').map(Number);
  return [0, 999].some((patch) => check([major ?? 0, min ?? 0, patch]));
}

/** Newest version from `candidates` ("8.1", "8.4", …) allowed by the constraint, or null. */
export function pickPhpVersion(constraint: string | null, candidates: readonly string[]): string | null {
  const sorted = [...candidates].sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]));
  if (!constraint) return sorted[0] ?? null;
  return sorted.find((version) => minorSatisfies(constraint, version)) ?? null;
}
