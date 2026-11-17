import type { APIRoute } from 'astro';
import { cancelUpload, getUploadMeta } from '../../../lib/storage';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const { uploadId } = body;

    if (!uploadId || typeof uploadId !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid uploadId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    cancelUpload(uploadId);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Upload canceled and temporary files purged',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('Upload cancel error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed to cancel upload' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
