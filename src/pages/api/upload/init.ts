import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import path from 'node:path';
import { saveUploadMeta, sanitizeFileName, type UploadMeta } from '../../../lib/storage';

export const prerender = false;

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MIN_FILE_SIZE = 1024; // 1 KB
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB chunks

const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.3gp', '.ts', '.mpeg', '.mpg', '.ogv'
]);

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { fileName, fileSize, fileType, settings } = body;

    if (!fileName || typeof fileName !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid fileName' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!fileSize || typeof fileSize !== 'number' || isNaN(fileSize)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid fileSize' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (fileSize > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({
          error: `File size exceeds the 2 GB limit. (Your file: ${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB)`
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (fileSize < MIN_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'File is too small to be a valid video' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return new Response(
        JSON.stringify({
          error: `Unsupported file format "${ext}". Supported formats: MP4, WebM, MKV, MOV, AVI, FLV, WMV, 3GP.`
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const chunkSize = DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const uploadId = crypto.randomUUID();
    const cleanFileName = sanitizeFileName(fileName);

    const meta: UploadMeta = {
      uploadId,
      fileName: cleanFileName,
      fileSize,
      fileType: fileType || 'video/mp4',
      chunkSize,
      totalChunks,
      settings: {
        targetSizeMB: settings?.targetSizeMB ? Number(settings.targetSizeMB) : 25,
        keepAudio: settings?.keepAudio !== false,
        keepFps: !!settings?.keepFps,
      },
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    saveUploadMeta(meta);

    return new Response(
      JSON.stringify({
        success: true,
        uploadId,
        chunkSize,
        totalChunks,
        fileName: cleanFileName,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('Upload init error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed to initialize upload' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
