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

  job.status = 'analyzing';
  job.statusText = 'Analyzing video…';
  job.progress = 2;
  saveJob(job);

  // ── Step 1: Probe duration and FPS ──
  let probeDuration = 0;
  let probeFps = 30;

  await new Promise<void>((resolve) => {
    const probeProc = spawn(ffmpegBin, ['-hide_banner', '-i', rawPath, '-f', 'null', '-']);
    let stderrData = '';

    probeProc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrData += text;
      const dm = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (dm) {
        probeDuration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
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

  // ── Step 2: Calculate encoding parameters ──
  const CRF_TABLE: Record<string, number> = {
    '8': 26,
    '25': 24,
    '50': 22,
    '100': 20,
  };
  const targetCrf = CRF_TABLE[String(targetSizeMB)] ?? 24;

  const AUDIO_BPS = 128_000;
  const EFFICIENCY = 0.85;
  const videoBitrateBps = (() => {
    if (probeDuration <= 0) return 1_000_000;
    const rawBudgetBits = targetSizeMB * 1024 * 1024 * 8;
    const audioTotalBits = (keepAudio ? AUDIO_BPS : 0) * probeDuration;
    const videoBits = rawBudgetBits * EFFICIENCY - audioTotalBits;
    const bps = videoBits / probeDuration;
    return Math.max(20_000, Math.min(bps, 50_000_000));
  })();
  const videoKbps = Math.max(1, Math.round(videoBitrateBps / 1000));

  // ── Step 3: Build FFmpeg command arguments ──
  const args = [
    '-y',
    '-i', rawPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', String(targetCrf),
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${Math.max(1, Math.round(videoKbps * 1.2))}k`,
    '-bufsize', `${Math.max(2, Math.round(videoKbps * 2))}k`,
    '-pix_fmt', 'yuv420p',
  ];

  if (keepAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  if (keepFps && probeFps > 0) {
    args.push('-r', probeFps.toFixed(3));
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

  // ── Step 5: Clean up raw input file immediately to save disk ──
  try {
    if (fs.existsSync(rawPath)) {
      fs.unlinkSync(rawPath);
    }
  } catch (err) {
    console.warn('Failed to delete raw file after compression:', err);
  }

  job.status = 'completed';
  job.progress = 100;
  job.statusText = 'Compression complete!';
  job.compressedSize = stat.size;
  job.completedAt = Date.now();
  saveJob(job);
}
