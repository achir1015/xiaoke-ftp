# 產生程式圖示：小柯機器人（頭盔造型）抱著 FTP 資料夾，上下傳輸箭頭
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024


def font(size, bold=True):
    for f in ('C:/Windows/Fonts/seguibl.ttf', 'C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def layer():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))


def shadow(img, box, radius, blur, alpha=140, ellipse=False):
    sh = layer()
    d = ImageDraw.Draw(sh)
    if ellipse:
        d.ellipse(box, fill=(0, 0, 0, alpha))
    else:
        d.rounded_rectangle(box, radius, fill=(0, 0, 0, alpha))
    return Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(blur)))


img = layer()

# ---- 資料夾（後片） ----
img = shadow(img, (96, 330, 930, 940), 80, 30)
fd = layer()
d = ImageDraw.Draw(fd)
d.rounded_rectangle((90, 300, 520, 470), 60, fill=(230, 150, 20, 255))          # 資料夾耳朵
d.rounded_rectangle((90, 360, 920, 900), 70, fill=(240, 166, 30, 255))          # 後片
img = Image.alpha_composite(img, fd)

# ---- 從資料夾探出的文件 ----
doc = layer()
d = ImageDraw.Draw(doc)
d.rounded_rectangle((170, 300, 520, 640), 30, fill=(255, 255, 255, 255))
for i, y in enumerate(range(360, 600, 52)):
    d.rounded_rectangle((215, y, 470 - (i % 2) * 70, y + 20), 10, fill=(170, 190, 215, 255))
doc = doc.rotate(-8, resample=Image.BICUBIC, center=(340, 470))
img = Image.alpha_composite(img, doc)

# ---- 資料夾（前片）＋ FTP 字樣 ----
fr = layer()
d = ImageDraw.Draw(fr)
d.rounded_rectangle((90, 480, 920, 900), 70, fill=(255, 196, 64, 255))
d.rounded_rectangle((90, 480, 920, 560), 40, fill=(255, 214, 110, 255))
d.rounded_rectangle((90, 520, 920, 900), 70, fill=(255, 196, 64, 255))
d.text((505, 730), 'FTP', font=font(270), fill=(25, 62, 140, 255), anchor='mm')
img = Image.alpha_composite(img, fr)

# ---- 上傳／下載雙箭頭（藍綠圓章） ----
img = shadow(img, (40, 40, 380, 380), 0, 20, 120, ellipse=True)
ar = layer()
d = ImageDraw.Draw(ar)
d.ellipse((30, 30, 360, 360), fill=(20, 170, 120, 255))
d.ellipse((48, 48, 342, 342), outline=(255, 255, 255, 255), width=10)
# 上箭頭
d.polygon([(140, 92), (82, 170), (118, 170), (118, 260), (162, 260), (162, 170), (198, 170)], fill=(255, 255, 255, 255))
# 下箭頭
d.polygon([(250, 298), (192, 220), (228, 220), (228, 130), (272, 130), (272, 220), (308, 220)], fill=(255, 255, 255, 255))
img = Image.alpha_composite(img, ar)

# ---- 小柯機器人（頭盔造型），坐在資料夾右上 ----
cx, cy = 700, 330
img = shadow(img, (cx - 220, cy - 170, cx + 250, cy + 260), 0, 24, 120, ellipse=True)
rb = layer()
r = ImageDraw.Draw(rb)
r.line((cx, cy - 240, cx, cy - 180), fill=(90, 100, 120, 255), width=18)        # 天線
r.ellipse((cx - 34, cy - 280, cx + 34, cy - 212), fill=(255, 80, 90, 255))
r.rounded_rectangle((cx - 262, cy - 60, cx - 208, cy + 80), 22, fill=(40, 120, 220, 255))   # 耳朵
r.rounded_rectangle((cx + 208, cy - 60, cx + 262, cy + 80), 22, fill=(40, 120, 220, 255))
r.ellipse((cx - 230, cy - 200, cx + 230, cy + 230), fill=(70, 150, 240, 255))  # 頭
r.ellipse((cx - 214, cy - 186, cx + 214, cy + 210), fill=(240, 246, 255, 255))
r.rounded_rectangle((cx - 170, cy - 100, cx + 170, cy + 100), 90, fill=(24, 36, 64, 255))   # 面罩
for ex in (cx - 72, cx + 72):                                                     # 笑眼
    r.arc((ex - 46, cy - 40, ex + 46, cy + 40), 200, 340, fill=(90, 230, 255, 255), width=22)
r.arc((cx - 50, cy + 20, cx + 50, cy + 80), 20, 160, fill=(90, 230, 255, 255), width=14)     # 嘴
r.ellipse((cx - 160, cy + 50, cx - 110, cy + 90), fill=(255, 140, 160, 200))    # 臉頰
r.ellipse((cx + 110, cy + 50, cx + 160, cy + 90), fill=(255, 140, 160, 200))
img = Image.alpha_composite(img, rb)

os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
img.save(os.path.join(ROOT, 'build', 'icon.png'))
img.save(os.path.join(ROOT, 'build', 'icon.ico'), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
os.makedirs(os.path.join(ROOT, 'src', 'renderer', 'img'), exist_ok=True)
img.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, 'src', 'renderer', 'img', 'logo.png'))
img.resize((64, 64), Image.LANCZOS).save(os.path.join(ROOT, 'src', 'renderer', 'img', 'logo64.png'))
print('ok')
