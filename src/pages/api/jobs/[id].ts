import type { APIRoute } from 'astro';
import { getJob } from '../../../lib/jobs';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id || typeof id !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing job ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const job = getJob(id);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        id: job.id,
        status: job.status,
        progress: job.progress,
        statusText: job.statusText,
        originalSize: job.originalSize,
        compressedSize: job.compressedSize,
        fileName: job.fileName,
        downloadUrl: job.downloadUrl,
        error: job.error,
        completedAt: job.completedAt,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('Get job error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed to fetch job' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
