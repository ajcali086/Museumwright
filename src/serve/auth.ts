/**
 * Who may use the desk. Visitors on the LAN read the museum; the curator
 * edits it. One passcode, set on first run with a one-time setup code the
 * server prints to its own console (so the first person to reach the box
 * over the network can't claim it), kept as a scrypt hash in the state
 * directory, outside the museum's repository. A signed-in desk is a random
 * session token in an HttpOnly, SameSite=Strict cookie, held in memory: a
 * restart signs everyone out.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DeskState = {
  passcode?: { salt: string; hash: string };
  /** The GitHub side, when the web is there: owner/name (or any git URL) and a token. */
  remote?: { repo: string; token?: string };
};

/** The state directory for a museum: outside its repository, one per museum path. */
export function stateDirFor(museum: string, override?: string): string {
  if (override) return resolve(override);
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const id = createHash("sha256").update(resolve(museum)).digest("hex").slice(0, 12);
  return join(base, "museumwright", id);
}

const hashOf = (passcode: string, salt: string) => scryptSync(passcode, salt, 32).toString("hex");

export class Desk {
  readonly dir: string;
  readonly setupCode: string;
  private sessions = new Map<string, { name: string; until: number }>();
  private failures = 0;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Four groups of four, no look-alikes: read off a console, typed on a phone.
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(16);
    this.setupCode = [0, 1, 2, 3].map((g) => [0, 1, 2, 3].map((i) => alphabet[bytes[g * 4 + i] % alphabet.length]).join("")).join("-");
  }

  private get file() {
    return join(this.dir, "desk.json");
  }

  read(): DeskState {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as DeskState) : {};
  }

  write(state: DeskState) {
    writeFileSync(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }

  get configured() {
    return !!this.read().passcode;
  }

  /** First run: the setup code from the console, and the passcode to keep. */
  setUp(code: string, passcode: string, name: string): string {
    if (this.configured) throw new DeskError(409, "The desk already has a passcode. Sign in.");
    const typed = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (typed !== this.setupCode.replace(/-/g, "")) throw new DeskError(403, "That isn't the setup code this server printed when it started.");
    if (passcode.length < 8) throw new DeskError(400, "A passcode needs at least eight characters.");
    const salt = randomBytes(16).toString("hex");
    this.write({ ...this.read(), passcode: { salt, hash: hashOf(passcode, salt) } });
    return this.open(name);
  }

  async signIn(passcode: string, name: string): Promise<string> {
    const p = this.read().passcode;
    if (!p) throw new DeskError(409, "The desk has no passcode yet. Use the setup code.");
    // Slower after each miss, so a passcode can't be guessed at speed.
    if (this.failures) await new Promise((r) => setTimeout(r, Math.min(5000, 250 * 2 ** this.failures)));
    const ok = timingSafeEqual(Buffer.from(hashOf(passcode, p.salt), "hex"), Buffer.from(p.hash, "hex"));
    if (!ok) {
      this.failures++;
      throw new DeskError(403, "Wrong passcode.");
    }
    this.failures = 0;
    return this.open(name);
  }

  private open(name: string): string {
    const who = name.trim();
    if (!who) throw new DeskError(400, "Say who is at the desk: decisions are recorded under that name.");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { name: who.slice(0, 80), until: Date.now() + 12 * 3600_000 });
    return token;
  }

  who(token: string | undefined): string | undefined {
    const s = token ? this.sessions.get(token) : undefined;
    if (!s) return undefined;
    if (s.until < Date.now()) {
      this.sessions.delete(token!);
      return undefined;
    }
    return s.name;
  }

  signOut(token: string | undefined) {
    if (token) this.sessions.delete(token);
  }
}

/** A refusal the desk shows as it is: a status and a sentence. */
export class DeskError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
