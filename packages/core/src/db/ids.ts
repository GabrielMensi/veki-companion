const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** ULID: 48 bits de tiempo (ms) + 80 bits aleatorios, Crockford base32, 26 caracteres. */
export function ulid(now: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const b of random(16)) rand += CROCKFORD[b % 32];
  return time + rand.slice(0, 16);
}

export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
