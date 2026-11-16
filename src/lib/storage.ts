import path from 'node:path';
import fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export interface UploadMeta {
  uploadId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  chunkSize: number;
  totalChunks: number;
  settings?: {
    targetSizeMB?: number;
    keepAudio?: boolean;
    keepFps?: boolean;
  };
  createdAt: number;
  lastActivity: number;
}

const BASE_STORAGE = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), '.storage');

export const CHUNKS_DIR = path.join(BASE_STORAGE, 'chunks');
export const RAW_DIR = path.join(BASE_STORAGE, 'raw');
export const COMPRESSED_DIR = path.join(BASE_STORAGE, 'compressed');
export const META_DIR = path.join(BASE_STORAGE, 'meta');

export function initStorage(): void {
  for (const dir of [BASE_STORAGE, CHUNKS_DIR, RAW_DIR, COMPRESSED_DIR, META_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Automatically ensure dirs exist
initStorage();

const UPLOAD_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120);
}

export function saveUploadMeta(meta: UploadMeta): void {
  if (!UPLOAD_ID_REGEX.test(meta.uploadId)) {
    throw new Error('Invalid upload ID format');
  }
  const metaPath = path.join(META_DIR, `upload_${meta.uploadId}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

export function getUploadMeta(uploadId: string): UploadMeta | null {
  if (!UPLOAD_ID_REGEX.test(uploadId)) return null;
  const metaPath = path.join(META_DIR, `upload_${uploadId}.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const data = fs.readFileSync(metaPath, 'utf-8');
    return JSON.parse(data) as UploadMeta;
  } catch {
    return null;
  }
}

export async function saveChunkStream(
  uploadId: string,
  chunkIndex: number,
  chunkStream: Readable
): Promise<{ bytesWritten: number }> {
  if (!UPLOAD_ID_REGEX.test(uploadId)) {
    throw new Error('Invalid upload ID format');
  }

  const meta = getUploadMeta(uploadId);
  if (!meta) {
    throw new Error('Upload session not found or expired');
  }
  if (chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
    throw new Error(`Invalid chunk index: ${chunkIndex} (total: ${meta.totalChunks})`);
  }

  const uploadDir = path.join(CHUNKS_DIR, uploadId);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Write the chunk straight into its final position in the raw file, so no
  // reassembly copy is needed once the upload finishes. Chunk directories now
  // only hold empty marker files recording which chunks have fully arrived.
  const rawPath = getRawPath(meta);
  fs.closeSync(fs.openSync(rawPath, 'a')); // create if missing, never truncate

  const start = chunkIndex * meta.chunkSize;
  const expectedBytes = Math.min(meta.chunkSize, meta.fileSize - start);
  // Never let a chunk spill past its slot into the next chunk's bytes. Excess
  // data is drained and dropped rather than aborting the stream mid-request
  // (aborting the request body stream crashes the Node adapter).
  let bytesReceived = 0;
  const guard = new Transform({
    transform(data: Buffer, _enc, cb) {
      const room = Math.max(0, expectedBytes - bytesReceived);
      bytesReceived += data.length;
      cb(null, data.length <= room ? data : data.subarray(0, room));
    },
  });

  await pipeline(chunkStream, guard, createWriteStream(rawPath, { flags: 'r+', start }));

  if (bytesReceived !== expectedBytes) {
    throw new Error(`Chunk ${chunkIndex} has wrong size: got ${bytesReceived} of ${expectedBytes} bytes`);
  }
  const bytesWritten = bytesReceived;

  // Mark the chunk as received only after its bytes are fully on disk
  fs.writeFileSync(path.join(uploadDir, `chunk_${chunkIndex}.part`), '');

  meta.lastActivity = Date.now();
  saveUploadMeta(meta);

  return { bytesWritten };
}

function getRawPath(meta: UploadMeta): string {
  const ext = path.extname(meta.fileName).toLowerCase() || '.mp4';
  return path.join(RAW_DIR, `${meta.uploadId}${ext}`);
}

export function getUploadedChunks(uploadId: string): number[] {
  if (!UPLOAD_ID_REGEX.test(uploadId)) return [];
  const uploadDir = path.join(CHUNKS_DIR, uploadId);
  if (!fs.existsSync(uploadDir)) return [];

  const files = fs.readdirSync(uploadDir);
  const indices: number[] = [];
  for (const f of files) {
    const m = f.match(/^chunk_(\d+)\.part$/);
    if (m) {
      indices.push(parseInt(m[1], 10));
    }
  }
  return indices.sort((a, b) => a - b);
}

export async function assembleChunks(uploadId: string): Promise<{ rawPath: string; totalBytes: number }> {
  const meta = getUploadMeta(uploadId);
  if (!meta) throw new Error('Upload session not found');

  const uploadDir = path.join(CHUNKS_DIR, uploadId);
  if (!fs.existsSync(uploadDir)) {
    throw new Error('Upload chunks directory missing');
  }

  // Verify all chunks exist
  for (let i = 0; i < meta.totalChunks; i++) {
    const chunkPath = path.join(uploadDir, `chunk_${i}.part`);
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Missing chunk ${i} of ${meta.totalChunks}`);
    }
  }

  // Chunks were already written in place by saveChunkStream — nothing to copy.
  const rawPath = getRawPath(meta);
  if (!fs.existsSync(rawPath)) {
    throw new Error('Uploaded file is missing');
  }
  const stat = fs.statSync(rawPath);
  if (stat.size !== meta.fileSize) {
    throw new Error(`Uploaded file size mismatch: ${stat.size} of ${meta.fileSize} bytes`);
  }

  // Clean up chunks folder to free disk space immediately
  try {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to clean up chunk dir:', err);
  }

  return { rawPath, totalBytes: stat.size };
}

export function cleanupStorage(): void {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  try {
    // 1. Clean abandoned chunk directories > 2 hours
    if (fs.existsSync(CHUNKS_DIR)) {
      const dirs = fs.readdirSync(CHUNKS_DIR);
      for (const d of dirs) {
        const full = path.join(CHUNKS_DIR, d);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > TWO_HOURS) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch {}
      }
    }

    // 2. Clean old raw files > 2 hours
    if (fs.existsSync(RAW_DIR)) {
      const files = fs.readdirSync(RAW_DIR);
      for (const f of files) {
        const full = path.join(RAW_DIR, f);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > TWO_HOURS) {
            fs.rmSync(full, { force: true });
          }
        } catch {}
      }
    }

    // 3. Clean old compressed files > 24 hours
    if (fs.existsSync(COMPRESSED_DIR)) {
      const files = fs.readdirSync(COMPRESSED_DIR);
      for (const f of files) {
        const full = path.join(COMPRESSED_DIR, f);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > ONE_DAY) {
            fs.rmSync(full, { force: true });
          }
        } catch {}
      }
    }

    // 4. Clean old meta files > 24 hours
    if (fs.existsSync(META_DIR)) {
      const files = fs.readdirSync(META_DIR);
      for (const f of files) {
        const full = path.join(META_DIR, f);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > ONE_DAY) {
            fs.rmSync(full, { force: true });
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('Storage cleanup encountered an error:', err);
  }
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startCleanupTimer(): void {
  if (!cleanupTimer && typeof setInterval !== 'undefined') {
    cleanupTimer = setInterval(cleanupStorage, 30 * 60 * 1000);
    cleanupTimer.unref();
  }
}

// Only start periodic cleanup when running as a long-lived server, not during build
if (typeof process !== 'undefined' && process.env.npm_lifecycle_event !== 'build') {
  startCleanupTimer();
}

