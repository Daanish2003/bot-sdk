/**
 * The same 32 bytes in other text: a SHA-256 in base64url has 2 unused bits in its last character, so
 * the next character of the alphabet decodes the same. Takes anything that ends in such a signature.
 */
export const otherSpelling = (signature: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const next = alphabet[alphabet.indexOf(signature.at(-1)!) + 1]!;
  return `${signature.slice(0, -1)}${next}`;
};
