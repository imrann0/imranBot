const { AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const fetch = require('node-fetch');

// System fontları yükle (text render için zorunlu)
try {
  if (process.platform === 'win32') {
    GlobalFonts.loadFontsFromDir('C:\\Windows\\Fonts');
  } else {
    // Linux / Docker
    for (const dir of ['/usr/share/fonts', '/usr/local/share/fonts']) {
      try { GlobalFonts.loadFontsFromDir(dir); } catch {}
    }
  }
} catch {}

function score() { return Math.floor(Math.random() * 101); }

function shipName(a, b) {
  const c = s => s.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ]/g, '') || s;
  const n1 = c(a), n2 = c(b);
  return n1.slice(0, Math.ceil(n1.length / 2)) + n2.slice(Math.floor(n2.length / 2));
}

function tierLabel(p) {
  if (p <= 10) return 'Felaketten beter...';
  if (p <= 24) return 'Hiç kimya yok';
  if (p <= 39) return 'Belki arkadaşlar';
  if (p <= 54) return 'Fena sayılmaz';
  if (p <= 64) return 'İyi arkadaşlar';
  if (p <= 74) return 'Potansiyel var!';
  if (p <= 84) return 'Bir şeyler var!';
  if (p <= 92) return 'Aşk mı bu?!';
  if (p <= 98) return 'Neredeyse evleniyorlar!';
  return 'Ruhsal ikizler!';
}

async function fetchAvatar(url) {
  const res = await fetch(url + '?size=256');
  return loadImage(Buffer.from(await res.arrayBuffer()));
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

function circle(ctx, x, y, r) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath();
}

function drawSparkle(ctx, x, y, size, alpha) {
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#ffb3d9'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  ctx.shadowColor = '#ff69b4'; ctx.shadowBlur = 6;
  const d = size, s = size * 0.55;
  ctx.beginPath();
  ctx.moveTo(x, y - d); ctx.lineTo(x, y + d);
  ctx.moveTo(x - d, y); ctx.lineTo(x + d, y);
  ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
  ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.globalAlpha = alpha * 0.9;
  circle(ctx, x, y, 1.5); ctx.fill(); ctx.restore();
}

function drawHeart(ctx, x, y, size, color, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.beginPath();
  const cx = x + size / 2, cy = y + size / 2;
  ctx.moveTo(cx, cy + size * 0.35);
  ctx.bezierCurveTo(cx - size * 0.5, cy, cx - size * 0.5, cy - size * 0.35, cx, cy - size * 0.1);
  ctx.bezierCurveTo(cx + size * 0.5, cy - size * 0.35, cx + size * 0.5, cy, cx, cy + size * 0.35);
  ctx.closePath(); ctx.fill(); ctx.restore();
}

async function buildShipImage(u1, u2, pct) {
  const W = 780, H = 300;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#07000f'; ctx.fillRect(0, 0, W, H);

  for (const n of [
    { x: 130, y: 70,  r: 200, c: 'rgba(80,0,120,0.45)'  },
    { x: 650, y: 220, r: 180, c: 'rgba(120,0,60,0.40)'  },
    { x: 390, y: 160, r: 140, c: 'rgba(90,0,90,0.30)'   },
    { x: 30,  y: 230, r: 130, c: 'rgba(40,0,100,0.30)'  },
    { x: 740, y: 60,  r: 150, c: 'rgba(100,0,50,0.30)'  },
  ]) {
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
    g.addColorStop(0, n.c); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  const cg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, 160);
  cg.addColorStop(0, 'rgba(255,50,140,0.12)'); cg.addColorStop(1, 'transparent');
  ctx.fillStyle = cg; ctx.fillRect(0, 0, W, H);

  for (const b of [
    { x: 18,  y: 25,  r: 55, c: '#ff2d78', a: 0.08 }, { x: 110, y: 265, r: 65, c: '#c44dff', a: 0.07 },
    { x: 720, y: 35,  r: 50, c: '#ff69b4', a: 0.08 }, { x: 660, y: 260, r: 70, c: '#ff2d78', a: 0.07 },
    { x: 390, y: 5,   r: 40, c: '#c44dff', a: 0.06 }, { x: 390, y: 295, r: 40, c: '#ff69b4', a: 0.06 },
  ]) {
    ctx.save();
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, b.c); g.addColorStop(0.6, b.c + '44'); g.addColorStop(1, 'transparent');
    ctx.globalAlpha = b.a; ctx.fillStyle = g; circle(ctx, b.x, b.y, b.r); ctx.fill(); ctx.restore();
  }

  for (const sp of [
    {x:48,y:58,s:7,a:0.75},{x:718,y:82,s:9,a:0.80},{x:205,y:22,s:6,a:0.65},
    {x:575,y:265,s:8,a:0.70},{x:92,y:218,s:6,a:0.60},{x:658,y:155,s:5,a:0.55},
    {x:315,y:275,s:6,a:0.65},{x:455,y:12,s:5,a:0.55},{x:172,y:278,s:5,a:0.50},
  ]) drawSparkle(ctx, sp.x, sp.y, sp.s, sp.a);

  drawHeart(ctx, 10, 10, 22, '#ff2d78', 0.25); drawHeart(ctx, W-42, 10, 22, '#ff2d78', 0.25);
  drawHeart(ctx, 10, H-42, 22, '#c44dff', 0.20); drawHeart(ctx, W-42, H-42, 22, '#c44dff', 0.20);
  drawHeart(ctx, W/2-11, 8, 18, '#ff69b4', 0.30); drawHeart(ctx, W/2-11, H-28, 18, '#ff69b4', 0.30);

  ctx.save(); ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 24;
  ctx.strokeStyle = 'rgba(255,45,120,0.7)'; ctx.lineWidth = 2.5;
  rrect(ctx, 3, 3, W-6, H-6, 18); ctx.stroke(); ctx.restore();

  const sName = shipName(u1.username, u2.username);
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 20px sans-serif'; ctx.fillStyle = '#ffb3d9';
  ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 16;
  ctx.fillText(`♥ ${sName} ♥`, W/2, 26); ctx.restore();

  const AVS = 186, AV1X = 28, AV2X = W-28-AVS, AVY = (H-AVS)/2+8;
  const ACX1 = AV1X+AVS/2, ACY = AVY+AVS/2, ACX2 = AV2X+AVS/2, AVRAD = AVS/2;

  const [av1, av2] = await Promise.all([
    fetchAvatar(u1.displayAvatarURL({ extension: 'png' })),
    fetchAvatar(u2.displayAvatarURL({ extension: 'png' })),
  ]);

  for (const [img, cx] of [[av1, ACX1], [av2, ACX2]]) {
    ctx.save(); ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 22;
    ctx.strokeStyle = '#ff2d78'; ctx.lineWidth = 3;
    circle(ctx, cx, ACY, AVRAD+5); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(255,180,220,0.50)'; ctx.lineWidth = 1.5;
    circle(ctx, cx, ACY, AVRAD+9); ctx.stroke(); ctx.restore();
    ctx.save(); circle(ctx, cx, ACY, AVRAD); ctx.clip();
    ctx.drawImage(img, cx-AVRAD, ACY-AVRAD, AVS, AVS); ctx.restore();
  }

  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 14px sans-serif'; ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffcce6';
  ctx.fillText(u1.username.slice(0,14), ACX1, AVY+AVS+16);
  ctx.fillText(u2.username.slice(0,14), ACX2, AVY+AVS+16); ctx.restore();

  const BW = 52, BH = 174, BX = W/2-BW/2, BY = (H-BH)/2+6, MID = W/2;
  ctx.save(); ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 18;
  ctx.fillStyle = 'rgba(255,45,120,0.10)'; rrect(ctx, BX-4, BY-4, BW+8, BH+8, 16); ctx.fill(); ctx.restore();
  ctx.save(); rrect(ctx, BX, BY, BW, BH, 12); ctx.fillStyle = 'rgba(8,0,20,0.75)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,45,120,0.60)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();

  const fillH = Math.max(8, Math.floor(BH*pct/100)), fillY = BY+BH-fillH;
  const fillG = ctx.createLinearGradient(0, fillY+fillH, 0, fillY);
  fillG.addColorStop(0, '#cc0055'); fillG.addColorStop(0.4, '#ff2d78');
  fillG.addColorStop(0.8, '#ff69b4'); fillG.addColorStop(1, '#ffb3d9');
  ctx.save(); rrect(ctx, BX+4, fillY, BW-8, fillH, 9); ctx.fillStyle = fillG; ctx.fill(); ctx.restore();

  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 15px sans-serif'; ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 10;
  ctx.fillText(`${pct}%`, MID, BY+BH+14); ctx.restore();

  const hFilled = Math.round(pct/20);
  const heartSz = [18,15,13,12,11];
  for (let i = 0; i < 5; i++) {
    const hx = BX+BW+8, hy = BY+i*(BH/5)+(BH/10)-heartSz[i]/2;
    drawHeart(ctx, hx, hy, heartSz[i], i < hFilled ? '#ff1493' : '#3a0030', i < hFilled ? 0.95 : 0.50);
  }

  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '26px sans-serif'; ctx.fillStyle = '#ff2d78';
  ctx.shadowColor = '#ff69b4'; ctx.shadowBlur = 20;
  ctx.fillText('♥', MID, BY-16); ctx.restore();

  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '13px sans-serif'; ctx.fillStyle = 'rgba(255,200,230,0.80)';
  ctx.shadowColor = '#ff2d78'; ctx.shadowBlur = 8;
  ctx.fillText(tierLabel(pct), MID, H-14); ctx.restore();

  for (const [cx, dir] of [[ACX1, 1], [ACX2, -1]]) {
    ctx.save();
    const lineX1 = cx+dir*(AVRAD+10), lineX2 = MID-dir*(BW/2+16);
    const lg = ctx.createLinearGradient(lineX1, 0, lineX2, 0);
    lg.addColorStop(0, 'rgba(255,45,120,0)'); lg.addColorStop(0.5, 'rgba(255,45,120,0.35)'); lg.addColorStop(1, 'rgba(255,45,120,0)');
    ctx.strokeStyle = lg; ctx.lineWidth = 1.5; ctx.setLineDash([4,5]);
    ctx.beginPath(); ctx.moveTo(lineX1, ACY); ctx.lineTo(lineX2, ACY); ctx.stroke(); ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  name: 'ship',
  aliases: ['sevgi', 'ask'],
  cooldown: 15, // saniye
  description: 'İki kullanıcının uyumunu ölçer',
  async execute(message, args) {
    const mentions = message.mentions.users;

    let u1, u2;
    if (mentions.size >= 2) {
      [u1, u2] = [...mentions.values()];
    } else if (mentions.size === 1) {
      u1 = message.author;
      u2 = mentions.first();
    } else {
      return message.reply('❌ Kullanım: `i?ship @kişi1 @kişi2` veya `i?ship @kişi`');
    }

    if (u1.id === u2.id) {
      return message.reply('❌ Kişi kendisiyle ship edilemez 😅');
    }

    const loadingMsg = await message.reply('💕 Hesaplanıyor...');

    try {
      const pct    = score();
      const imgBuf = await buildShipImage(u1, u2, pct);
      await loadingMsg.edit({ content: '', files: [new AttachmentBuilder(imgBuf, { name: 'ship.png' })] });
    } catch (err) {
      console.error('[prefix ship]', err);
      await loadingMsg.edit('❌ Resim oluşturulurken bir hata oluştu.');
    }
  },
};
