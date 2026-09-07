import type { APIRoute } from 'astro';
import { assembleChunks, getUploadMeta, saveUploadMeta } from '../../../lib/storage';
import { createJob } from '../../../lib/jobs';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { uploadId, settings } = body;

    if (!uploadId || typeof uploadId !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid uploadId' }), {
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

    // Update settings if provided at completion
    if (settings) {
      meta.settings = {
        targetSizeMB: settings.targetSizeMB ? Number(settings.targetSizeMB) : (meta.settings?.targetSizeMB || 25),
        keepAudio: settings.keepAudio !== undefined ? !!settings.keepAudio : (meta.settings?.keepAudio !== false),
        keepFps: settings.keepFps !== undefined ? !!settings.keepFps : (!!meta.settings?.keepFps),
      };
      saveUploadMeta(meta);
    }

    // Reassemble file directly on disk via streams (ZERO RAM CONCATENATION)
    const { rawPath, totalBytes } = await assembleChunks(uploadId);

    // Create asynchronous background compression job
    const job = createJob(uploadId, rawPath);

    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        totalBytes,
        status: job.status,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('Upload complete error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed to complete upload' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
