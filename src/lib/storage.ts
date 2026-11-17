import path from 'node:path';
import fs from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

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

  const chunkPath = path.join(uploadDir, `chunk_${chunkIndex}.part`);
  const tempPath = `${chunkPath}.tmp`;

  const writeStream = createWriteStream(tempPath);
  await pipeline(chunkStream, writeStream);

  // Atomic rename so unfinished writes never appear as valid chunks
  fs.renameSync(tempPath, chunkPath);

  meta.lastActivity = Date.now();
  saveUploadMeta(meta);

  const stat = fs.statSync(chunkPath);
  return { bytesWritten: stat.size };
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

  const ext = path.extname(meta.fileName).toLowerCase() || '.mp4';
  const rawPath = path.join(RAW_DIR, `${uploadId}${ext}`);

  // Reassemble sequentially by streaming each chunk directly to destination file
  const destStream = createWriteStream(rawPath, { flags: 'w' });
  for (let i = 0; i < meta.totalChunks; i++) {
    const chunkPath = path.join(uploadDir, `chunk_${i}.part`);
    const chunkReadStream = createReadStream(chunkPath, { highWaterMark: 64 * 1024 });
    await pipeline(chunkReadStream, destStream, { end: false });
  }
  destStream.end();

  await new Promise<void>((resolve, reject) => {
    destStream.on('finish', () => resolve());
    destStream.on('error', reject);
  });

  const stat = fs.statSync(rawPath);

  // Clean up chunks folder to free disk space immediately
  try {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to clean up chunk dir:', err);
  }

  return { rawPath, totalBytes: stat.size };
}

export function cancelUpload(uploadId: string): void {
  if (!UPLOAD_ID_REGEX.test(uploadId)) return;
  const uploadDir = path.join(CHUNKS_DIR, uploadId);
  if (fs.existsSync(uploadDir)) {
    try {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    } catch {}
  }
  const metaPath = path.join(META_DIR, `upload_${uploadId}.json`);
  if (fs.existsSync(metaPath)) {
    try {
      fs.unlinkSync(metaPath);
    } catch {}
  }
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

