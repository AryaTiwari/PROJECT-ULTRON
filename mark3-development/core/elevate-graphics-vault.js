const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const factory = require('./reel-factory');

const VERSION = 1;
const ROOT = path.join(factory.REEL_ROOT, 'graphics-vault-v1');
const WIDTH = 1080;
const HEIGHT = 1920;

const BACKGROUNDS = Object.freeze({
  initial_clean_dark: { family: 'initial', style: 'clean-dark' },
  initial_gradient_glow: { family: 'initial', style: 'gradient-glow' },
  initial_grid_tech: { family: 'initial', style: 'grid-tech' },
  initial_paper_texture: { family: 'initial', style: 'paper-texture' },
  initial_spotlight: { family: 'initial', style: 'spotlight' },
  devil_red_chaos: { family: 'devil', style: 'red-chaos' },
  devil_glitch_noise: { family: 'devil', style: 'glitch-noise' },
  devil_inferno: { family: 'devil', style: 'inferno' },
  creator_creator_room: { family: 'creator', style: 'creator-room' },
  creator_city_motivation: { family: 'creator', style: 'city-motivation' },
  creator_content_studio: { family: 'creator', style: 'content-studio' },
  creator_planning_desk: { family: 'creator', style: 'planning-desk' },
  creator_success_path: { family: 'creator', style: 'success-path' },
});

const METRICS = Object.freeze([
  'views', 'followers', 'likes', 'comments', 'shares', 'saves', 'watch_time',
  'retention', 'skip_rate', 'profile_visits', 'reach', 'growth',
  'new_follower', 'lost_follower', 'conversion',
]);

const UI = Object.freeze([
  'hook', 'problem', 'solution', 'cta', 'skip', 'low_retention',
  'no_follow', 'follow', 'save_this', 'viral', 'trending',
]);

const CHARTS = Object.freeze([
  'retention_graph', 'growth_graph', 'funnel', 'comparison',
  'skip_rate_ring', 'engagement_strip',
]);

const FX = Object.freeze([
  'arrow', 'circle', 'highlight', 'check', 'x', 'exclaim', 'question',
  'glow', 'focus_frame',
]);

const PALETTE = Object.freeze({
  bg: [5, 9, 18, 255],
  panel: [9, 18, 34, 235],
  blue: [31, 165, 255, 255],
  blue2: [70, 104, 255, 255],
  cyan: [30, 232, 255, 255],
  red: [239, 68, 68, 255],
  red2: [185, 28, 28, 255],
  pink: [236, 72, 153, 255],
  green: [34, 197, 94, 255],
  yellow: [250, 204, 21, 255],
  white: [245, 249, 255, 255],
  muted: [75, 94, 125, 255],
  clear: [0, 0, 0, 0],
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodeRgba(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 7 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function canvas(width, height, fill = PALETTE.clear) {
  const rgba = Buffer.alloc(width * height * 4);
  const c = { width, height, rgba };
  if (fill[3]) rect(c, 0, 0, width, height, fill);
  return c;
}

function blend(c, x, y, color) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (y * c.width + x) * 4;
  const a = color[3] / 255;
  const ia = 1 - a;
  c.rgba[i] = Math.round(color[0] * a + c.rgba[i] * ia);
  c.rgba[i + 1] = Math.round(color[1] * a + c.rgba[i + 1] * ia);
  c.rgba[i + 2] = Math.round(color[2] * a + c.rgba[i + 2] * ia);
  c.rgba[i + 3] = Math.min(255, Math.round(color[3] + c.rgba[i + 3] * ia));
}

function rect(c, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(c.width, Math.round(x + w));
  const y1 = Math.min(c.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) blend(c, xx, yy, color);
}

function circle(c, cx, cy, r, color, stroke = 0) {
  const r2 = r * r;
  const inner = Math.max(0, r - stroke);
  const i2 = inner * inner;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d <= r2 && (!stroke || d >= i2)) blend(c, x, y, color);
    }
  }
}

function line(c, x0, y0, x1, y1, color, thickness = 5) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    circle(c, x0, y0, Math.max(1, Math.floor(thickness / 2)), color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function triangle(c, a, b, d, color) {
  const minX = Math.floor(Math.min(a[0], b[0], d[0]));
  const maxX = Math.ceil(Math.max(a[0], b[0], d[0]));
  const minY = Math.floor(Math.min(a[1], b[1], d[1]));
  const maxY = Math.ceil(Math.max(a[1], b[1], d[1]));
  const area = (p1, p2, p3) => (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]));
  const full = area(a, b, d);
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const p = [x, y];
    const w1 = area(p, b, d), w2 = area(a, p, d), w3 = area(a, b, p);
    if ((full >= 0 && w1 >= 0 && w2 >= 0 && w3 >= 0) || (full < 0 && w1 <= 0 && w2 <= 0 && w3 <= 0)) blend(c, x, y, color);
  }
}

function gradient(c, top, bottom) {
  for (let y = 0; y < c.height; y += 1) {
    const t = y / Math.max(1, c.height - 1);
    const col = [0, 1, 2, 3].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t));
    rect(c, 0, y, c.width, 1, col);
  }
}

function roundedPanel(c, x, y, w, h, color, border = null) {
  rect(c, x + 22, y, w - 44, h, color);
  rect(c, x, y + 22, w, h - 44, color);
  circle(c, x + 22, y + 22, 22, color);
  circle(c, x + w - 22, y + 22, 22, color);
  circle(c, x + 22, y + h - 22, 22, color);
  circle(c, x + w - 22, y + h - 22, 22, color);
  if (border) {
    rect(c, x + 22, y, w - 44, 3, border);
    rect(c, x + 22, y + h - 3, w - 44, 3, border);
    rect(c, x, y + 22, 3, h - 44, border);
    rect(c, x + w - 3, y + 22, 3, h - 44, border);
  }
}

function drawGrid(c, step = 96, color = [28, 42, 68, 120]) {
  for (let x = 0; x < c.width; x += step) rect(c, x, 0, 2, c.height, color);
  for (let y = 0; y < c.height; y += step) rect(c, 0, y, c.width, 2, color);
}

function drawSparkles(c, color, count, seed) {
  let state = seed >>> 0;
  const rand = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0xffffffff; };
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rand() * c.width), y = Math.floor(rand() * c.height);
    const r = 2 + Math.floor(rand() * 6);
    line(c, x - r, y, x + r, y, color, 2);
    line(c, x, y - r, x, y + r, color, 2);
  }
}

function renderBackground(id) {
  const c = canvas(WIDTH, HEIGHT, PALETTE.bg);
  const style = BACKGROUNDS[id]?.style || 'clean-dark';
  if (style === 'clean-dark') {
    gradient(c, [2, 7, 18, 255], [5, 20, 39, 255]);
    circle(c, 170, 1620, 460, [0, 145, 255, 28]);
    circle(c, 920, 240, 360, [111, 66, 193, 20]);
  } else if (style === 'gradient-glow') {
    gradient(c, [4, 8, 28, 255], [14, 16, 45, 255]);
    circle(c, 840, 520, 430, [77, 45, 255, 60]);
    circle(c, 210, 1460, 540, [0, 190, 255, 45]);
  } else if (style === 'grid-tech') {
    gradient(c, [3, 9, 19, 255], [7, 24, 38, 255]);
    drawGrid(c, 96, [23, 75, 110, 100]);
    for (let i = 0; i < 5; i += 1) rect(c, 130 + i * 170, 1490 - i * 80, 90, 180 + i * 80, [22, 133, 220, 120]);
  } else if (style === 'paper-texture') {
    gradient(c, [9, 13, 23, 255], [17, 21, 30, 255]);
    drawSparkles(c, [220, 230, 244, 28], 260, 41);
    triangle(c, [0, 0], [720, 0], [0, 740], [238, 241, 245, 34]);
    triangle(c, [1080, 1920], [380, 1920], [1080, 1190], [238, 241, 245, 26]);
  } else if (style === 'spotlight') {
    gradient(c, [2, 5, 12, 255], [5, 8, 15, 255]);
    for (let r = 440; r > 20; r -= 16) circle(c, 540, 1000, r, [120, 190, 255, Math.max(2, Math.round((450 - r) / 24))]);
    circle(c, 540, 1500, 310, [80, 160, 255, 16]);
  } else if (style === 'red-chaos') {
    gradient(c, [20, 2, 6, 255], [58, 3, 9, 255]);
    for (let i = 0; i < 16; i += 1) line(c, -100 + i * 95, 1920, 420 + i * 45, 0, [230, 30, 50, 70], 8);
    drawSparkles(c, [255, 65, 80, 130], 90, 9);
  } else if (style === 'glitch-noise') {
    gradient(c, [9, 4, 12, 255], [34, 1, 10, 255]);
    for (let i = 0; i < 70; i += 1) {
      const y = (i * 137) % HEIGHT, w = 90 + ((i * 71) % 650), x = (i * 173) % Math.max(1, WIDTH - w);
      rect(c, x, y, w, 4 + (i % 8), i % 3 ? [160, 15, 40, 120] : [255, 40, 70, 150]);
    }
  } else if (style === 'inferno') {
    gradient(c, [18, 2, 4, 255], [78, 6, 2, 255]);
    for (let i = 0; i < 16; i += 1) {
      const x = 20 + i * 70, h = 180 + ((i * 83) % 450);
      triangle(c, [x, 1920], [x + 70, 1920], [x + 35, 1920 - h], i % 2 ? [255, 70, 15, 150] : [255, 185, 20, 110]);
    }
  } else if (style === 'creator-room' || style === 'content-studio') {
    gradient(c, [5, 11, 24, 255], [13, 27, 42, 255]);
    rect(c, 120, 1120, 840, 22, [55, 75, 105, 255]);
    roundedPanel(c, 150, 620, 520, 330, [6, 12, 22, 255], [35, 118, 185, 255]);
    rect(c, 210, 710, 400, 150, [14, 55, 88, 255]);
    line(c, 790, 600, 790, 1390, [83, 98, 122, 255], 12);
    circle(c, 790, 610, 150, style === 'content-studio' ? [230, 80, 255, 48] : [31, 165, 255, 45], 12);
  } else if (style === 'city-motivation') {
    gradient(c, [11, 23, 48, 255], [55, 40, 66, 255]);
    for (let i = 0; i < 14; i += 1) {
      const w = 65 + (i % 3) * 32, h = 330 + ((i * 127) % 750), x = i * 88 - 50;
      rect(c, x, HEIGHT - h, w, h, [10, 24, 45, 255]);
      for (let y = HEIGHT - h + 45; y < HEIGHT - 40; y += 70) rect(c, x + 15, y, 12, 22, [255, 190, 90, 130]);
    }
  } else if (style === 'planning-desk') {
    gradient(c, [9, 14, 22, 255], [31, 31, 31, 255]);
    rect(c, 0, 1280, WIDTH, 640, [48, 33, 25, 255]);
    roundedPanel(c, 175, 480, 730, 620, [238, 225, 188, 255], [172, 135, 75, 255]);
    for (let i = 0; i < 5; i += 1) {
      circle(c, 255, 600 + i * 92, 18, [244, 173, 35, 255], 5);
      line(c, 310, 600 + i * 92, 790, 600 + i * 92, [90, 75, 60, 160], 7);
    }
  } else if (style === 'success-path') {
    gradient(c, [6, 20, 43, 255], [29, 85, 140, 255]);
    for (let i = 0; i < 9; i += 1) {
      const w = 500 - i * 42, x = (WIDTH - w) / 2, y = 1550 - i * 120;
      rect(c, x, y, w, 56, [230, 240, 255, 165]);
    }
    line(c, 540, 650, 540, 1550, [80, 215, 255, 110], 8);
  }
  return c;
}

function renderMetric(id) {
  const c = canvas(256, 256);
  const blue = PALETTE.blue, red = PALETTE.red, green = PALETTE.green, white = PALETTE.white;
  const accent = ['lost_follower', 'skip_rate'].includes(id) ? red : ['growth', 'new_follower', 'conversion'].includes(id) ? green : blue;
  if (id === 'views') {
    circle(c, 128, 128, 74, accent, 13); circle(c, 128, 128, 30, white);
  } else if (['followers', 'new_follower', 'lost_follower', 'profile_visits'].includes(id)) {
    circle(c, 108, 91, 39, accent); roundedPanel(c, 52, 136, 112, 72, accent);
    if (id !== 'followers') {
      line(c, 172, 124, 226, 124, white, 10);
      if (id === 'new_follower' || id === 'profile_visits') line(c, 199, 97, 199, 151, white, 10);
    }
  } else if (id === 'likes') {
    circle(c, 92, 105, 48, PALETTE.pink); circle(c, 164, 105, 48, PALETTE.pink);
    triangle(c, [49, 120], [207, 120], [128, 220], PALETTE.pink);
  } else if (id === 'comments') {
    roundedPanel(c, 38, 58, 180, 126, [139, 92, 246, 255]);
    triangle(c, [85, 184], [128, 184], [84, 222], [139, 92, 246, 255]);
    circle(c, 92, 122, 8, white); circle(c, 128, 122, 8, white); circle(c, 164, 122, 8, white);
  } else if (id === 'shares') {
    triangle(c, [32, 116], [224, 44], [162, 218], accent); triangle(c, [67, 117], [178, 78], [143, 158], PALETTE.bg);
  } else if (id === 'saves') {
    rect(c, 62, 40, 132, 170, accent); triangle(c, [62, 210], [128, 158], [194, 210], PALETTE.clear); rect(c, 86, 62, 84, 8, white);
  } else if (id === 'watch_time') {
    circle(c, 128, 132, 84, accent, 14); line(c, 128, 132, 128, 77, white, 11); line(c, 128, 132, 176, 151, white, 11);
  } else if (id === 'retention' || id === 'growth') {
    line(c, 38, 185, 89, 147, accent, 14); line(c, 89, 147, 134, 165, accent, 14); line(c, 134, 165, 208, 78, accent, 14);
    triangle(c, [208, 78], [176, 88], [199, 110], accent);
  } else if (id === 'skip_rate') {
    triangle(c, [48, 58], [48, 198], [126, 128], accent); triangle(c, [114, 58], [114, 198], [192, 128], accent); rect(c, 194, 58, 15, 140, accent);
  } else if (id === 'reach') {
    for (let i = 0; i < 5; i += 1) rect(c, 42 + i * 37, 190 - i * 29, 25, 36 + i * 29, accent);
  } else if (id === 'conversion') {
    rect(c, 35, 57, 186, 34, accent); rect(c, 60, 105, 136, 34, accent); rect(c, 86, 153, 84, 34, accent); triangle(c, [86, 187], [170, 187], [128, 229], accent);
  } else {
    circle(c, 128, 128, 78, accent, 13); circle(c, 128, 128, 18, white);
  }
  return c;
}

function renderUi(id) {
  const c = canvas(480, 180);
  const colors = {
    hook: PALETTE.blue, problem: PALETTE.red, solution: PALETTE.green, cta: [126, 34, 206, 255],
    skip: PALETTE.red, low_retention: [245, 158, 11, 255], no_follow: PALETTE.red,
    follow: PALETTE.green, save_this: PALETTE.blue, viral: PALETTE.pink, trending: PALETTE.cyan,
  };
  const accent = colors[id] || PALETTE.blue;
  roundedPanel(c, 12, 25, 456, 130, [5, 12, 24, 225], accent);
  rect(c, 12, 25, 10, 130, accent);
  if (id === 'skip') {
    triangle(c, [120, 60], [120, 120], [165, 90], accent); triangle(c, [165, 60], [165, 120], [210, 90], accent); rect(c, 214, 60, 8, 60, accent);
  } else if (id === 'low_retention') {
    line(c, 105, 65, 165, 118, accent, 13); line(c, 165, 118, 230, 105, accent, 13); line(c, 230, 105, 300, 136, accent, 13); triangle(c, [300, 136], [270, 113], [289, 94], accent);
  } else if (id === 'no_follow' || id === 'follow') {
    circle(c, 145, 70, 25, accent); roundedPanel(c, 105, 103, 80, 42, accent); line(c, 260, 92, 345, 92, accent, 13);
    if (id === 'follow') line(c, 302, 51, 302, 133, accent, 13);
  } else if (id === 'save_this') {
    rect(c, 110, 45, 85, 100, accent); triangle(c, [110, 145], [152, 112], [195, 145], PALETTE.clear);
    line(c, 240, 90, 360, 90, accent, 13);
  } else {
    circle(c, 128, 90, 38, accent, 10); line(c, 205, 90, 370, 90, accent, 13);
  }
  return c;
}

function renderChart(id) {
  const c = canvas(800, 420);
  const panel = [5, 11, 22, 205];
  roundedPanel(c, 5, 5, 790, 410, panel, [34, 68, 108, 210]);
  if (id === 'retention_graph') {
    const pts = [[80, 80], [180, 110], [280, 145], [380, 205], [500, 250], [620, 320], [720, 350]];
    for (let i = 0; i < pts.length - 1; i += 1) line(c, ...pts[i], ...pts[i + 1], PALETTE.red, 12);
    pts.forEach(([x, y]) => circle(c, x, y, 9, PALETTE.white));
  } else if (id === 'growth_graph') {
    for (let i = 0; i < 6; i += 1) rect(c, 80 + i * 105, 340 - i * 42, 60, 60 + i * 42, i === 5 ? PALETTE.green : PALETTE.blue);
    line(c, 80, 300, 690, 80, PALETTE.cyan, 9);
  } else if (id === 'funnel') {
    [[110, 85, 580], [160, 165, 480], [215, 245, 370], [285, 325, 230]].forEach(([x, y, w], i) => rect(c, x, y, w, 54, [31 + i * 30, 130 + i * 20, 255 - i * 45, 230]));
  } else if (id === 'comparison') {
    rect(c, 115, 235, 180, 125, PALETTE.blue); rect(c, 505, 105, 180, 255, PALETTE.green);
    line(c, 400, 55, 400, 365, [100, 120, 150, 180], 4);
  } else if (id === 'skip_rate_ring') {
    circle(c, 400, 210, 132, PALETTE.red, 28); circle(c, 400, 210, 72, [245, 249, 255, 35], 4);
    triangle(c, [376, 155], [376, 265], [460, 210], PALETTE.white);
  } else {
    const colors = [PALETTE.pink, [139, 92, 246, 255], PALETTE.cyan, PALETTE.blue];
    for (let i = 0; i < 4; i += 1) {
      circle(c, 110 + i * 185, 130, 44, colors[i]);
      rect(c, 65 + i * 185, 235, 90, 95 + i * 14, colors[i]);
    }
  }
  return c;
}

function renderFx(id) {
  const c = canvas(512, 512);
  if (id === 'arrow') {
    line(c, 70, 390, 385, 100, PALETTE.white, 18); triangle(c, [385, 100], [310, 120], [375, 185], PALETTE.white);
  } else if (id === 'circle') {
    circle(c, 256, 256, 170, PALETTE.red, 18);
  } else if (id === 'highlight') {
    line(c, 70, 300, 440, 260, PALETTE.yellow, 28); line(c, 85, 335, 425, 310, [250, 204, 21, 150], 18);
  } else if (id === 'check') {
    line(c, 105, 270, 215, 370, PALETTE.green, 28); line(c, 215, 370, 420, 130, PALETTE.green, 28);
  } else if (id === 'x') {
    line(c, 120, 120, 392, 392, PALETTE.red, 28); line(c, 392, 120, 120, 392, PALETTE.red, 28);
  } else if (id === 'exclaim') {
    rect(c, 236, 95, 40, 245, PALETTE.red); circle(c, 256, 397, 27, PALETTE.red);
  } else if (id === 'question') {
    circle(c, 256, 210, 115, PALETTE.blue, 20); line(c, 256, 300, 256, 350, PALETTE.blue, 20); circle(c, 256, 408, 22, PALETTE.blue);
  } else if (id === 'focus_frame') {
    const col = PALETTE.cyan;
    rect(c, 45, 45, 150, 12, col); rect(c, 45, 45, 12, 150, col); rect(c, 317, 45, 150, 12, col); rect(c, 455, 45, 12, 150, col);
    rect(c, 45, 455, 150, 12, col); rect(c, 45, 317, 12, 150, col); rect(c, 317, 455, 150, 12, col); rect(c, 455, 317, 12, 150, col);
  } else {
    for (let r = 180; r > 12; r -= 14) circle(c, 256, 256, r, [31, 165, 255, Math.max(2, Math.round((190 - r) / 3))], 10);
  }
  return c;
}

function writeAsset(category, id, c) {
  const dir = path.join(ROOT, category);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.png`);
  const bytes = encodeRgba(c.width, c.height, c.rgba);
  fs.writeFileSync(file, bytes);
  return file;
}

function requiredFiles() {
  return [
    ...Object.keys(BACKGROUNDS).map((id) => path.join(ROOT, 'backgrounds', `${id}.png`)),
    ...METRICS.map((id) => path.join(ROOT, 'metrics', `${id}.png`)),
    ...UI.map((id) => path.join(ROOT, 'ui', `${id}.png`)),
    ...CHARTS.map((id) => path.join(ROOT, 'charts', `${id}.png`)),
    ...FX.map((id) => path.join(ROOT, 'fx', `${id}.png`)),
  ];
}

function ready() {
  const files = requiredFiles();
  return files.every((file) => fs.existsSync(file) && fs.statSync(file).size > 100);
}

function manifest() {
  return {
    version: VERSION,
    zeroSetup: true,
    networkRequired: false,
    generatedAt: new Date().toISOString(),
    counts: {
      backgrounds: Object.keys(BACKGROUNDS).length,
      metrics: METRICS.length,
      ui: UI.length,
      charts: CHARTS.length,
      fx: FX.length,
    },
    totalAssets: Object.keys(BACKGROUNDS).length + METRICS.length + UI.length + CHARTS.length + FX.length,
    resolution: { backgrounds: '1080x1920', transparentElements: 'PNG RGBA' },
  };
}

function ensure(options = {}) {
  if (ready() && !options.force) return { ok: true, alreadyReady: true, root: ROOT, ...manifest() };
  fs.mkdirSync(ROOT, { recursive: true });
  for (const id of Object.keys(BACKGROUNDS)) writeAsset('backgrounds', id, renderBackground(id));
  for (const id of METRICS) writeAsset('metrics', id, renderMetric(id));
  for (const id of UI) writeAsset('ui', id, renderUi(id));
  for (const id of CHARTS) writeAsset('charts', id, renderChart(id));
  for (const id of FX) writeAsset('fx', id, renderFx(id));
  const data = manifest();
  fs.writeFileSync(path.join(ROOT, 'manifest.json'), `${JSON.stringify(data, null, 2)}\n`);
  return { ok: ready(), root: ROOT, ...data };
}

function asset(category, id) {
  ensure();
  const file = path.join(ROOT, category, `${id}.png`);
  return fs.existsSync(file) ? file : null;
}

function backgroundForScene(scene = {}, index = 0) {
  const stage = String(scene.characterStory?.stage || '').toLowerCase();
  const prop = String(scene.characterStory?.prop || '').toLowerCase();
  if (/conflict|devil-dominant/.test(stage)) return asset('backgrounds', index % 2 ? 'devil_glitch_noise' : 'devil_red_chaos');
  if (/diagnosis/.test(stage)) return asset('backgrounds', 'creator_content_studio');
  if (/prescription/.test(stage)) return asset('backgrounds', 'creator_planning_desk');
  if (/cta/.test(stage)) return asset('backgrounds', 'creator_success_path');
  if (/retention|skip/.test(prop)) return asset('backgrounds', 'devil_glitch_noise');
  if (/creator-hero/.test(stage)) return asset('backgrounds', 'initial_gradient_glow');
  return asset('backgrounds', ['initial_clean_dark', 'initial_grid_tech', 'creator_creator_room'][index % 3]);
}

function visualKitForScene(scene = {}) {
  const prop = String(scene.characterStory?.prop || '').toLowerCase();
  const type = String(scene.characterStory?.type || '').toLowerCase();
  const kit = { metrics: [], ui: [], chart: null, fx: [] };
  if (prop === 'views-vs-follows') { kit.metrics = ['views', 'followers']; kit.chart = 'comparison'; }
  else if (prop === 'retention-graph') { kit.metrics = ['retention', 'skip_rate']; kit.chart = 'retention_graph'; }
  else if (prop === 'conversion-funnel') { kit.metrics = ['profile_visits', 'followers', 'conversion']; kit.chart = 'funnel'; }
  else if (prop === 'hook-meter') { kit.metrics = ['retention']; kit.chart = 'skip_rate_ring'; }
  else if (prop === 'brand-card') { kit.metrics = ['reach', 'growth']; kit.chart = 'growth_graph'; }
  else { kit.metrics = ['growth', 'followers']; kit.chart = 'engagement_strip'; }
  if (type === 'devil-interruption') { kit.ui.push('skip'); kit.fx.push('exclaim'); }
  if (type === 'metric-consequence') { kit.metrics.push('lost_follower'); kit.ui.push('no_follow'); }
  if (type === 'doctor-diagnosis') kit.ui.push('low_retention');
  if (type === 'doctor-prescription') { kit.ui.push('solution'); kit.fx.push('check'); }
  if (type === 'elevate-close') { kit.ui.push('cta'); kit.metrics.push('conversion'); }
  kit.metrics = [...new Set(kit.metrics)].slice(0, 3);
  kit.ui = [...new Set(kit.ui)].slice(0, 2);
  kit.fx = [...new Set(kit.fx)].slice(0, 1);
  return kit;
}

function status() {
  const data = manifest();
  return {
    implemented: true,
    ready: ready(),
    root: ROOT,
    zeroSetup: true,
    localImportRequired: false,
    networkRequired: false,
    commercialUse: true,
    lightweight: true,
    ...data,
  };
}

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = {
  VERSION, ROOT, BACKGROUNDS, METRICS, UI, CHARTS, FX,
  ensure, ready, asset, backgroundForScene, visualKitForScene, status, checksum,
  renderBackground, renderMetric, renderUi, renderChart, renderFx, encodeRgba,
};
