// Byte helpers the link session and the fast player share: base64 for JSON bodies and channel messages, deflate-raw for
// saves and save states on the run's channel, SHA-1 for checking what arrived.

/** Bytes → base64 (in slices: String.fromCharCode takes only so many arguments). */
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
export const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'));

/** SHA-1 of bytes, hex. */
export const sha1 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
