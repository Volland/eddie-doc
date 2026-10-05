/** `n` random bytes as lowercase hex. Uses WebCrypto where it exists. */
export function randomHex(n: number): string {
  const bytes = new Uint8Array(n);
  const c = typeof crypto === "undefined" ? undefined : (crypto as { getRandomValues?(a: Uint8Array): Uint8Array });
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
