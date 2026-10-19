// Space ids (design §4.2). One alphabet for the server and the web client: the definitions are in
// shared/src/ids.ts (lower-case Crockford base32, 80 random bits from crypto.getRandomValues).

export { generateSpaceId, isSpaceId, SPACE_ID_ALPHABET, SPACE_ID_RE } from '@shared/ids';
