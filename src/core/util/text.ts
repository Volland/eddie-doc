/**
 * Decode UTF-8 bytes, keeping a leading byte-order mark.
 *
 * `Buffer#toString("utf8")` keeps a BOM as U+FEFF, and every offset the matcher
 * and the anchors record was computed against text decoded that way.
 * `TextDecoder` strips the BOM by default, which would shift each of them by
 * one, so decoding goes through here.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
