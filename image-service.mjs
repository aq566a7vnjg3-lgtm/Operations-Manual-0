import sharp from 'sharp';
import { createHash } from 'node:crypto';

sharp.cache({ memory: 16, files: 0, items: 32 });
sharp.concurrency(1);

const MAX_PIXELS = 16_000_000;
const inputOptions = { limitInputPixels: MAX_PIXELS, failOn: 'error' };
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const dimensionsFor = meta => {
  const rotated = meta.orientation >= 5 && meta.orientation <= 8;
  return { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
};

export function decodeImage(src) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src || '');
  if (!match) invalid('PNG・JPEG・WebP画像を選択してください。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) invalid('画像データが正しくありません。');
  return { bytes, type: `image/${match[1]}` };
}

export async function imageDimensions(src) {
  try {
    const { bytes } = decodeImage(src);
    const meta = await sharp(bytes, inputOptions).metadata();
    return dimensionsFor(meta);
  } catch {
    // Preserve older records even when their encoded images cannot be inspected.
    return { width: 4, height: 3 };
  }
}

async function pixelDigest(bytes) {
  const hash = createHash('sha256');
  for await (const chunk of sharp(bytes, inputOptions).autoOrient().toColourspace('srgb').ensureAlpha().raw()) hash.update(chunk);
  return hash.digest('hex');
}

export async function optimizeImage(src) {
  const { bytes, type } = decodeImage(src);
  if (bytes.length > 30 * 1024 * 1024) invalid('読込前の画像は30MBまでです。');
  const signatureMatches = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureMatches) invalid('画像の形式と内容が一致しません。');
  try {
    const meta = await sharp(bytes, inputOptions).metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || `image/${meta.format}` !== type) invalid('画像の形式と内容が一致しません。');
    if ((meta.pages || 1) > 1) invalid('アニメーション画像には対応していません。静止画像を選択してください。');
    const dimensions = dimensionsFor(meta);
    let chosen = bytes, chosenType = type;
    // Never downsample or truncate high-bit-depth images. Compare decoded pixels,
    // including transparent RGB, before accepting the smaller lossless encoding.
    if (meta.depth === 'uchar' && dimensions.width <= 16383 && dimensions.height <= 16383) {
      const candidate = await sharp(bytes, inputOptions).autoOrient().keepIccProfile()
        .webp({ lossless: true, exact: true, effort: 4 }).toBuffer();
      if (candidate.length < bytes.length) {
        const source = await pixelDigest(bytes);
        const decoded = await pixelDigest(candidate);
        if (source === decoded) { chosen = candidate; chosenType = 'image/webp'; }
      }
    }
    return {
      src: `data:${chosenType};base64,${chosen.toString('base64')}`,
      ...dimensions, bytes: chosen.length, originalBytes: bytes.length,
      format: chosenType, converted: chosen !== bytes
    };
  } catch (error) {
    if (error.status) throw error;
    invalid('画像を読み取れません。破損していないPNG・JPEG・WebP（1600万画素以内）を選択してください。');
  }
}
