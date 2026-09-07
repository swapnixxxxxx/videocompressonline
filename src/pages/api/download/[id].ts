import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { COMPRESSED_DIR } from '../../../lib/storage';
import { getJob } from '../../../lib/jobs';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const { id } = params;
    if (!id || typeof id !== 'string') {
      return new Response('Missing file ID', { status: 400 });
    }

    // Sanitize ID
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
      return new Response('Invalid file ID', { status: 400 });
    }

    const filePath = path.join(COMPRESSED_DIR, `${id}.mp4`);
    if (!fs.existsSync(filePath)) {
      return new Response('File not found or expired', { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    const job = getJob(id);
    const originalBase = job?.fileName ? job.fileName.replace(/\.[^/.]+$/, '') : 'video';
    const downloadName = `compressed_${originalBase}.mp4`;

    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        return new Response('Requested range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });
      const webStream = Readable.toWeb(fileStream);

      return new Response(webStream as any, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
        },
      });
    }

    // Stream entire file
    const fileStream = fs.createReadStream(filePath);
    const webStream = Readable.toWeb(fileStream);

    return new Response(webStream as any, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    console.error('Download error:', err);
    return new Response('Internal server error', { status: 500 });
  }
};
