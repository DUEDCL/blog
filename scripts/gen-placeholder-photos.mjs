// 一次性脚本：生成摄影栏目的占位图，跑完即可删除。
// 用 sharp 合成抽象色块，不联网下载素材。
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const OUT = 'src/content/photos';

/** 低饱和抽象图，模拟照片的明暗层次 */
function svg({ w, h, from, to, accent }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect x="0" y="${h * 0.62}" width="${w}" height="${h * 0.38}"
          fill="#000" opacity="0.14"/>
    <circle cx="${w * 0.74}" cy="${h * 0.26}" r="${Math.min(w, h) * 0.12}"
            fill="${accent}" opacity="0.5"/>
    <rect x="${w * 0.08}" y="${h * 0.44}" width="${w * 0.3}" height="${h * 0.5}"
          fill="#000" opacity="0.1"/>
  </svg>`;
}

const shots = [
  { name: 'street-01', w: 1600, h: 1067, from: '#8d9aa5', to: '#3f474e', accent: '#e8d9c0' },
  { name: 'street-02', w: 1200, h: 1500, from: '#b9ada0', to: '#4a423b', accent: '#d8c4a8' },
  { name: 'street-03', w: 1600, h: 1067, from: '#7f8b93', to: '#2f3639', accent: '#c9d4d8' },
  { name: 'quiet-01', w: 1200, h: 1500, from: '#a8b0a4', to: '#3b423a', accent: '#e2e6d8' },
  { name: 'quiet-02', w: 1600, h: 1067, from: '#9c9187', to: '#38322d', accent: '#ddcfbb' },
];

await mkdir(OUT, { recursive: true });

for (const s of shots) {
  await sharp(Buffer.from(svg(s)))
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(`${OUT}/${s.name}.jpg`);
  console.log(`生成 ${OUT}/${s.name}.jpg (${s.w}x${s.h})`);
}
