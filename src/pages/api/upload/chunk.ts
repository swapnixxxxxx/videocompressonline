import type { APIRoute } from 'astro';
import { Readable } from 'node:stream';
import { saveChunkStream, getUploadMeta } from '../../../lib/storage';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const uploadId = request.headers.get('x-upload-id');
    const chunkIndexStr = request.headers.get('x-chunk-index');

    if (!uploadId || !chunkIndexStr) {
      return new Response(JSON.stringify({ error: 'Missing x-upload-id or x-chunk-index header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const chunkIndex = parseInt(chunkIndexStr, 10);
    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return new Response(JSON.stringify({ error: 'Invalid chunk index' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const meta = getUploadMeta(uploadId);
    if (!meta) {
      return new Response(JSON.stringify({ error: 'Upload session expired or not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (chunkIndex >= meta.totalChunks) {
      return new Response(JSON.stringify({ error: `Chunk index ${chunkIndex} out of bounds (total: ${meta.totalChunks})` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!request.body) {
      return new Response(JSON.stringify({ error: 'Empty request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream directly from HTTP body to disk file — ZERO RAM BUFFERING!
    const nodeStream = Readable.fromWeb(request.body as any);
    const { bytesWritten } = await saveChunkStream(uploadId, chunkIndex, nodeStream);

    return new Response(
      JSON.stringify({
        success: true,
        uploadId,
        chunkIndex,
        bytesWritten,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('Chunk upload error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed to save chunk' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
