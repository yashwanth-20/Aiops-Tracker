'use strict';

/**
 * Image storage with two backends:
 *  - Vercel Blob when BLOB_READ_WRITE_TOKEN is set (serverless has no writable disk)
 *  - local filesystem under data/uploads otherwise
 */

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const MAX_BYTES = 8 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
};

const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function decodeDataUrl(dataUrl) {
  const m = /^data:([a-z/+.-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('image must be a base64 data URL');

  const contentType = m[1].toLowerCase();
  const ext = EXT_BY_MIME[contentType];
  if (!ext) throw new Error('unsupported image type (use PNG, JPG, GIF, WEBP or BMP)');

  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw new Error('image is empty');
  if (buffer.length > MAX_BYTES) throw new Error('image is larger than 8 MB');

  return { buffer, contentType, ext };
}

async function saveImage(dataUrl, month, id) {
  const { buffer, contentType, ext } = decodeDataUrl(dataUrl);
  const key = `snapshots/${month}/${id}${ext}`;

  if (useBlob) {
    const { put } = require('@vercel/blob');
    const result = await put(key, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true
    });
    return result.url;
  }

  const dir = path.join(UPLOAD_DIR, month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}${ext}`), buffer);
  return `/uploads/${month}/${id}${ext}`;
}

async function deleteImage(url) {
  if (!url) return;

  if (url.startsWith('http')) {
    if (!useBlob) return;
    const { del } = require('@vercel/blob');
    await del(url).catch(() => {});
    return;
  }

  if (!url.startsWith('/uploads/')) return;
  const target = path.resolve(UPLOAD_DIR, url.slice('/uploads/'.length));
  if (!target.startsWith(UPLOAD_DIR + path.sep)) return;
  fs.rmSync(target, { force: true });
}

async function deleteImages(urls) {
  for (const url of urls) await deleteImage(url);
}

module.exports = { UPLOAD_DIR, MAX_BYTES, saveImage, deleteImage, deleteImages, useBlob };
