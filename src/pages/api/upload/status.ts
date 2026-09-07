import type { APIRoute } from 'astro';
import { getUploadMeta, getUploadedChunks } from '../../../lib/storage';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const uploadId = url.searchParams.get('uploadId');

    if (!uploadId) {
      return new Response(JSON.stringify({ error: 'Missing uploadId parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const meta = getUploadMeta(uploadId);
    if (!meta) {
      return new Response(JSON.stringify({ error: 'Upload session not found or expired' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const uploadedChunks = getUploadedChunks(uploadId);
    const isComplete = uploadedChunks.length === meta.totalChunks;

    return new Response(
      JSON.stringify({
        uploadId,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        totalChunks: meta.totalChunks,
        chunkSize: meta.chunkSize,
        uploadedChunks,
        uploadedCount: uploadedChunks.length,
        isComplete,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('Upload status error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed to check status' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
