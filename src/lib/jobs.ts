import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { COMPRESSED_DIR, META_DIR, RAW_DIR, getUploadMeta } from './storage';

export interface Job {
  id: string;
  uploadId: string;
  fileName: string;
  originalSize: number;
  status: 'queued' | 'analyzing' | 'compressing' | 'completed' | 'failed';
  progress: number;
  statusText: string;
  compressedSize: number;
  downloadUrl: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

const jobs = new Map<string, Job>();

function getFfmpegBin(): string {
  if (typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  return 'ffmpeg';
}

function saveJob(job: Job): void {
  job.updatedAt = Date.now();
  jobs.set(job.id, job);
  try {
    const metaPath = path.join(META_DIR, `job_${job.id}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(job, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`Failed to persist job ${job.id}:`, err);
  }
}

export function getJob(jobId: string): Job | null {
  if (jobs.has(jobId)) {
    return jobs.get(jobId)!;
  }
  try {
    const metaPath = path.join(META_DIR, `job_${jobId}.json`);
    if (fs.existsSync(metaPath)) {
      const data = fs.readFileSync(metaPath, 'utf-8');
      const job = JSON.parse(data) as Job;
      jobs.set(job.id, job);
      return job;
    }
  } catch {}
  return null;
}

export function createJob(uploadId: string, rawPath: string): Job {
  const meta = getUploadMeta(uploadId);
  const fileName = meta?.fileName || 'video.mp4';
  const originalSize = meta?.fileSize || (fs.existsSync(rawPath) ? fs.statSync(rawPath).size : 0);

  const jobId = uploadId;
  const job: Job = {
    id: jobId,
    uploadId,
    fileName,
    originalSize,
    status: 'queued',
    progress: 0,
    statusText: 'Queued for processing',
    compressedSize: 0,
    downloadUrl: `/api/download/${jobId}`,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
  };

  saveJob(job);
  // Start compression asynchronously without blocking the caller
  queueMicrotask(() => {
    runCompression(job, rawPath).catch((err) => {
      console.error(`Job ${jobId} failed:`, err);
      job.status = 'failed';
      job.statusText = 'Compression failed';
      job.error = err?.message || 'An unexpected error occurred during compression';
      saveJob(job);
    });
  });

  return job;
}

async function runCompression(job: Job, rawPath: string): Promise<void> {
  const meta = getUploadMeta(job.uploadId);
  const settings = meta?.settings || {};
  const targetSizeMB = Number(settings.targetSizeMB) || 25;
  const keepAudio = settings.keepAudio !== false;
  const keepFps = !!settings.keepFps;

  const ffmpegBin = getFfmpegBin();
  const outputPath = path.join(COMPRESSED_DIR, `${job.id}.mp4`);

  try {
    job.status = 'analyzing';
    job.statusText = 'Analyzing video…';
    job.progress = 2;
    saveJob(job);

    // ── Step 1: Probe duration, resolution and FPS (1-frame fast probe) ──
    let probeDuration = 0;
    let probeFps = 30;
    let probeWidth = 1920;
    let probeHeight = 1080;

    await new Promise<void>((resolve) => {
      const probeProc = spawn(ffmpegBin, ['-hide_banner', '-i', rawPath, '-frames:v', '1', '-f', 'null', '-']);
      let stderrData = '';

      probeProc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrData += text;
        const dm = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
        if (dm) {
          probeDuration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
        }
        const resMatch = text.match(/Stream #\d+:\d+.*Video:.*,\s*(\d{3,4})x(\d{3,4})/);
        if (resMatch) {
          probeWidth = parseInt(resMatch[1], 10);
          probeHeight = parseInt(resMatch[2], 10);
        }
        const fm = text.match(/(\d+(?:\.\d+)?)\s*fps\b/);
        if (fm) {
          const v = parseFloat(fm[1]);
          if (v > 0 && v <= 240) probeFps = v;
        }
      });

      probeProc.on('close', () => {
        if (probeDuration <= 0) {
          const dm = stderrData.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
          if (dm) {
            probeDuration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
          }
        }
        resolve();
      });

      probeProc.on('error', () => resolve());
    });

    // ── Step 2: Calculate motion, bitrate and scaling parameters ──
    const estimatedBitrate = probeDuration > 0 ? Math.round((job.originalSize * 8) / probeDuration / 1000) : 2500;
    const pixelCount = probeWidth * probeHeight;
    const bitratePerPixel = pixelCount > 0 ? (estimatedBitrate / pixelCount) * 1000 : 0.05;
    const hasMotion = bitratePerPixel > 0.1 || estimatedBitrate > 3000;

    const CRF_TABLE: Record<string, number> = {
      '8': hasMotion ? 24 : 26,
      '25': hasMotion ? 22 : 24,
      '50': hasMotion ? 20 : 22,
      '100': 20,
    };
    const targetCrf = CRF_TABLE[String(targetSizeMB)] ?? 24;

    const EFFICIENCY = hasMotion ? 0.80 : 0.85;
    const totalBudgetBits = (targetSizeMB * 1024 * 1024 * 8) * EFFICIENCY;
    const targetBitrateBps = probeDuration > 0 ? totalBudgetBits / probeDuration : 1_500_000;
    const audioBitrateBps = keepAudio ? Math.min(128_000, Math.round(targetBitrateBps * 0.12)) : 0;
    const videoBitrateBps = Math.max(150_000, targetBitrateBps - audioBitrateBps);
    const videoKbps = Math.max(150, Math.round(videoBitrateBps / 1000));
    const audioKbps = keepAudio ? Math.max(32, Math.round(audioBitrateBps / 1000)) : 0;

    // ── Step 3: Build FFmpeg command arguments ──
    const args = [
      '-y',
      '-i', rawPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'film',
      '-crf', String(targetCrf),
      '-b:v', `${videoKbps}k`,
      '-maxrate', `${Math.max(1, Math.round(videoKbps * 1.2))}k`,
      '-bufsize', `${hasMotion ? Math.round(videoKbps * 3) : Math.round(videoKbps * 2)}k`,
      '-refs', '1',
      '-bf', '0',
      '-me_method', 'hex',
      '-subq', '3',
      '-pix_fmt', 'yuv420p',
    ];

    // Target-based intelligent downscaling filter
    let scaleFilter: string | null = null;
    if (targetSizeMB <= 8) {
      scaleFilter = 'scale=\'min(854,iw)\':-2:flags=fast_bilinear';
    } else if (targetSizeMB <= 25) {
      scaleFilter = 'scale=\'min(1280,iw)\':-2:flags=fast_bilinear';
    } else if (targetSizeMB <= 50) {
      scaleFilter = 'scale=\'min(1920,iw)\':-2:flags=fast_bilinear';
    }

    if (scaleFilter) {
      args.push('-vf', scaleFilter);
    }

    if (keepAudio) {
      args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`);
    } else {
      args.push('-an');
    }

    if (keepFps && probeFps > 0) {
      args.push('-r', probeFps.toFixed(3));
    } else if (!keepFps) {
      const fpsCap = targetSizeMB <= 8 ? 24 : 30;
      if (probeFps > fpsCap) {
        args.push('-r', String(fpsCap));
      }
    }

    args.push('-movflags', '+faststart', outputPath);

    // ── Step 4: Run FFmpeg with progress streaming ──
    job.status = 'compressing';
    job.statusText = `Compressing (Target: ${targetSizeMB} MB)…`;
    job.progress = 5;
    saveJob(job);

    await new Promise<void>((resolve, reject) => {
      const ffmpegProc = spawn(ffmpegBin, args);
      let stderrLog = '';

      ffmpegProc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrLog += text;

        // Parse FFmpeg timecode: time=00:01:23.45
        const tm = text.match(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
        if (tm && probeDuration > 0) {
          const elapsed = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
          const pct = Math.min(99, Math.max(5, Math.round((elapsed / probeDuration) * 95)));
          if (pct > job.progress) {
            job.progress = pct;
            job.statusText = `Compressing: ${pct}%`;
            saveJob(job);
          }
        }
      });

      ffmpegProc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const lastLines = stderrLog.slice(-500);
          reject(new Error(`FFmpeg exited with code ${code}. Details: ${lastLines}`));
        }
      });

      ffmpegProc.on('error', (err) => {
        reject(err);
      });
    });

    // Verify output file
    if (!fs.existsSync(outputPath)) {
      throw new Error('Compressed output file was not generated.');
    }

    const stat = fs.statSync(outputPath);
    if (stat.size < 1024) {
      throw new Error('Compressed output file is corrupted or empty (< 1 KB).');
    }

    job.status = 'completed';
    job.progress = 100;
    job.statusText = 'Compression complete!';
    job.compressedSize = stat.size;
    job.completedAt = Date.now();
    saveJob(job);
  } catch (err: any) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
    throw err;
  } finally {
    // ── Clean up raw input file immediately to save disk ──
    try {
      if (fs.existsSync(rawPath)) {
        fs.unlinkSync(rawPath);
      }
    } catch (err) {
      console.warn('Failed to delete raw file after compression:', err);
    }
  }
}
