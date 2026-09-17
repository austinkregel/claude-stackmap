/**
 * Addresses in an export are hex text ("0x401000"), and in a non-default address space they carry it
 * ("SECTION30::0x1a0"). Hex text does not sort or range-compare numerically ("0x9" would come after
 * "0x10"), so every row also stores a key: the space, then the offset zero-padded to 16 hex digits.
 * Keys sort and compare the way addresses do, which is what ordering and BETWEEN need.
 */
export interface ParsedAddress {
  space: string;
  offset: bigint;
  key: string;
}

export function parseAddress(text: string, where: string): ParsedAddress {
  const sep = text.lastIndexOf("::");
  const space = sep === -1 ? "" : text.slice(0, sep);
  const hex = sep === -1 ? text : text.slice(sep + 2);
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${where}: "${text}" is not an address (expected 0x-hex, optionally "space::0x-hex")`);
  const offset = BigInt(hex);
  return { space, offset, key: addressKey(space, offset) };
}

export const addressKey = (space: string, offset: bigint) => `${space}:${offset.toString(16).padStart(16, "0")}`;

/** The key for an address as written in an export. */
export const keyOf = (text: string, where = "address") => parseAddress(text, where).key;
