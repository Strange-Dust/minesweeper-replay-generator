/**
 * Minimal ZIP file generator (STORE method, no compression).
 *
 * Creates valid ZIP archives from text file entries without any external
 * dependencies. Uses the STORE compression method (no compression), which
 * is suitable for small text files like RAWVF replays.
 *
 * Only supports:
 *   - UTF-8 filenames and content
 *   - STORE (no compression)
 *   - Files under 4GB (no ZIP64)
 */

// ============================================================================
// CRC-32
// ============================================================================

/**
 * CRC-32 lookup table, pre-computed at module load.
 */
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c
}

/**
 * Compute CRC-32 checksum for a byte array.
 */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ============================================================================
// ZIP generation
// ============================================================================

/**
 * A file entry to include in the ZIP archive.
 */
export interface ZipEntry {
  /** Filename (may include path separators, e.g. "replays/game1.rawvf") */
  filename: string
  /** File content as a UTF-8 string */
  content: string
}

/**
 * Create a ZIP archive Blob from an array of text file entries.
 *
 * Uses STORE method (no compression) and UTF-8 encoding for both
 * filenames and content.
 */
export function createZipBlob(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []

  interface FileRecord {
    nameBytes: Uint8Array
    dataBytes: Uint8Array
    crc: number
    offset: number
  }

  const records: FileRecord[] = []
  let offset = 0

  // --- Local file headers + file data ---
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename)
    const dataBytes = encoder.encode(entry.content)
    const crc = crc32(dataBytes)

    records.push({ nameBytes, dataBytes, crc, offset })

    // Local file header: 30 fixed bytes + filename
    const header = new ArrayBuffer(30)
    const hv = new DataView(header)
    hv.setUint32(0, 0x04034B50, true)          // Local file header signature
    hv.setUint16(4, 20, true)                   // Version needed to extract (2.0)
    hv.setUint16(6, 0x0800, true)               // General purpose bit flag (bit 11 = UTF-8)
    hv.setUint16(8, 0, true)                    // Compression method: STORE
    hv.setUint16(10, 0, true)                   // Last mod file time
    hv.setUint16(12, 0, true)                   // Last mod file date
    hv.setUint32(14, crc, true)                 // CRC-32
    hv.setUint32(18, dataBytes.length, true)    // Compressed size
    hv.setUint32(22, dataBytes.length, true)    // Uncompressed size
    hv.setUint16(26, nameBytes.length, true)    // Filename length
    hv.setUint16(28, 0, true)                   // Extra field length

    parts.push(new Uint8Array(header))
    parts.push(nameBytes)
    parts.push(dataBytes)

    offset += 30 + nameBytes.length + dataBytes.length
  }

  // --- Central directory ---
  const centralDirOffset = offset
  let centralDirSize = 0

  for (const record of records) {
    const entry = new ArrayBuffer(46)
    const ev = new DataView(entry)
    ev.setUint32(0, 0x02014B50, true)           // Central directory signature
    ev.setUint16(4, 20, true)                   // Version made by (2.0)
    ev.setUint16(6, 20, true)                   // Version needed to extract (2.0)
    ev.setUint16(8, 0x0800, true)               // General purpose bit flag (UTF-8)
    ev.setUint16(10, 0, true)                   // Compression method: STORE
    ev.setUint16(12, 0, true)                   // Last mod file time
    ev.setUint16(14, 0, true)                   // Last mod file date
    ev.setUint32(16, record.crc, true)          // CRC-32
    ev.setUint32(20, record.dataBytes.length, true) // Compressed size
    ev.setUint32(24, record.dataBytes.length, true) // Uncompressed size
    ev.setUint16(28, record.nameBytes.length, true) // Filename length
    ev.setUint16(30, 0, true)                   // Extra field length
    ev.setUint16(32, 0, true)                   // File comment length
    ev.setUint16(34, 0, true)                   // Disk number start
    ev.setUint16(36, 0, true)                   // Internal file attributes
    ev.setUint32(38, 0, true)                   // External file attributes
    ev.setUint32(42, record.offset, true)       // Relative offset of local header

    parts.push(new Uint8Array(entry))
    parts.push(record.nameBytes)

    centralDirSize += 46 + record.nameBytes.length
  }

  // --- End of central directory record ---
  const endRecord = new ArrayBuffer(22)
  const endView = new DataView(endRecord)
  endView.setUint32(0, 0x06054B50, true)        // End of central directory signature
  endView.setUint16(4, 0, true)                  // Number of this disk
  endView.setUint16(6, 0, true)                  // Disk where central directory starts
  endView.setUint16(8, records.length, true)      // Number of entries on this disk
  endView.setUint16(10, records.length, true)     // Total number of entries
  endView.setUint32(12, centralDirSize, true)     // Size of central directory
  endView.setUint32(16, centralDirOffset, true)   // Offset of central directory
  endView.setUint16(20, 0, true)                  // ZIP file comment length

  parts.push(new Uint8Array(endRecord))

  return new Blob(parts as BlobPart[], { type: 'application/zip' })
}
