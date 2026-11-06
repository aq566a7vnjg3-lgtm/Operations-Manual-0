import sharp from 'sharp';

export const imageManual = {
  id: 'image-qa', title: '画像検証マニュアル', category: '検証', description: '画像の品質・通信・操作の検証用',
  updated: '2026-11-06', steps: Array.from({ length: 12 }, (_, i) => `手順 ${i + 1}：登録内容を確認する。`),
  tags: ['検証'], keywords: [], required: ['画面を確認'], related: [], images: [], notice: '', danger: ''
};

export async function screenshotFixture() {
  const rows = Array.from({ length: 30 }, (_, i) => `<path d="M20 ${70 + i * 30}H1700" stroke="#a7b4bd" stroke-width="1"/><text x="30" y="${91 + i * 30}" font-size="15" fill="#172b38">${String(i + 1).padStart(2, '0')}  Registration / ABCdef 0123456789 / Check fine text and one-pixel lines</text>`).join('');
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><rect width="1920" height="1080" fill="white"/><rect width="1920" height="50" fill="#1a73e8"/><text x="30" y="32" fill="white" font-size="22">Business Manual: Lossless screenshot quality check</text>${rows}<rect x="1730" y="75" width="160" height="960" fill="#109e7b" fill-opacity="0.4"/></svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
}

export const dataImage = (bytes, type = 'png') => `data:image/${type};base64,${bytes.toString('base64')}`;
