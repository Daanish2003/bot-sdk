/**
 * Checks on a DOCX before it is parsed (ported from Sim Studio's `zip-guard.ts` and
 * `ooxml-encryption.ts`, Apache-2.0, at 22c3de1f). A password-protected DOCX is an OLE2 container
 * holding the `EncryptionInfo` and `EncryptedPackage` streams, so its bytes never look like a ZIP.
 * A small ZIP can declare huge entries, so the declared sizes are summed from the central directory
 * before any entry is inflated.
 */

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_RECORD = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const CENTRAL_DIRECTORY_RECORD_BYTES = 46;

/** The limits Sim uses for OOXML archives: 150 MB summed, 64 MB per entry, 10,000 entries, 4 MB of extra fields. */
const maxTotalUncompressedBytes = 150 * 1024 * 1024;
const maxEntryUncompressedBytes = 64 * 1024 * 1024;
const maxEntries = 10_000;
const maxExtraFieldBytes = 4 * 1024 * 1024;

const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** The directory sits in the first sectors; 64 KiB covers every real file. */
const directoryScanBytes = 64 * 1024;

/** The archive declares more than the limits allow: it is too large or too complex to read. */
export class ZipBombError extends Error {}

/** The bytes aren't a ZIP archive this check can verify. */
export class ArchiveIntegrityError extends Error {}

/** Whether the buffer is an OLE2 container carrying an encrypted OOXML package. Inflates nothing. */
export function isEncryptedOoxmlContainer(buffer: Buffer): boolean {
  if (buffer.length < OLE2_SIGNATURE.length) return false;
  if (!buffer.subarray(0, OLE2_SIGNATURE.length).equals(OLE2_SIGNATURE)) return false;
  const head = buffer.subarray(0, directoryScanBytes);
  return (
    head.includes(Buffer.from("EncryptedPackage", "utf16le")) &&
    head.includes(Buffer.from("EncryptionInfo", "utf16le"))
  );
}

/**
 * Reads the ZIP central directory and throws if the archive declares too much: a ZipBombError when
 * the declared sizes or entry count pass the limits, an ArchiveIntegrityError when the directory
 * can't be read.
 */
export function assertOoxmlArchiveWithinLimits(buffer: Buffer): void {
  const end = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff) {
    throw new ArchiveIntegrityError("ZIP64 archives are not supported");
  }
  if (entries > maxEntries) throw new ZipBombError("The archive has too many entries");

  let offset = directoryOffset;
  let total = 0;
  let extra = 0;
  for (let index = 0; index < entries; index++) {
    if (
      offset + CENTRAL_DIRECTORY_RECORD_BYTES > buffer.length ||
      buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_RECORD
    ) {
      throw new ArchiveIntegrityError("The central directory is damaged");
    }
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    total += size;
    extra += extraLength;
    if (size > maxEntryUncompressedBytes) throw new ZipBombError("An entry is too large");
    if (total > maxTotalUncompressedBytes) throw new ZipBombError("The archive is too large");
    if (extra > maxExtraFieldBytes) throw new ZipBombError("The archive is too complex");

    offset += CENTRAL_DIRECTORY_RECORD_BYTES + nameLength + extraLength + commentLength;
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw new ArchiveIntegrityError("The file is not a ZIP archive");
  }
  const earliest = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_BYTES - 0xffff);
  for (let index = buffer.length - END_OF_CENTRAL_DIRECTORY_BYTES; index >= earliest; index--) {
    if (buffer.readUInt32LE(index) === ZIP_END_OF_CENTRAL_DIRECTORY) return index;
  }
  throw new ArchiveIntegrityError("The file is not a ZIP archive");
}
