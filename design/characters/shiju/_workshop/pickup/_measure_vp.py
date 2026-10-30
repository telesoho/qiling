from pathlib import Path
from PIL import Image
import numpy as np

REMBG = Path(r"C:\Users\telesoho\prjs\my\qiling\design\anim\诗琚-吊起\white-rembg")
SCALE = 211/517
SCALED = round(720 * SCALE)
print("SCALE", SCALE, "SCALED", SCALED)

def bbox(path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im)[:,:,3]
    ys, xs = np.where(a > 8)
    if len(xs)==0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), int(ys.max()-ys.min()+1), int(xs.max()-xs.min()+1)

tops=[]; bots=[]; lefts=[]; rights=[]
worst_top=None; worst_bot=None
for i in range(1,194):
    p = REMBG / f"{i:04d}.png"
    b = bbox(p)
    if not b: continue
    x0,y0,x1,y1,h,w = b
    sy0 = y0 * SCALE
    sy1 = (y1+1) * SCALE
    sx0 = x0 * SCALE
    sx1 = (x1+1) * SCALE
    tops.append(sy0); bots.append(sy1); lefts.append(sx0); rights.append(sx1)
    if worst_top is None or sy0 < worst_top[0]:
        worst_top = (sy0, i, b)
    if worst_bot is None or sy1 > worst_bot[0]:
        worst_bot = (sy1, i, b)

print("scaled top min", min(tops), "frame", worst_top[1], "src", worst_top[2])
print("scaled bot max", max(bots), "frame", worst_bot[1], "src", worst_bot[2])
print("union h", max(bots)-min(tops), "union w", max(rights)-min(lefts))
for name in ["0001","0050","0100","0160","0193"]:
    print(name, bbox(REMBG/f"{name}.png"))

VX, VY = 57, 45
print("current vp y", VY, "->", VY+240, "x", VX, "->", VX+180)
print("clip top", VY - min(tops))
print("clip bot", max(bots) - (VY+240))

union_top, union_bot = min(tops), max(bots)
uh = union_bot - union_top
margin = 4
print("need h", uh, "spare", 240-uh)
VY2 = int(round(union_top)) - margin
if VY2 < 0: VY2 = 0
if VY2 + 240 < union_bot + margin:
    need = uh + 2*margin
    new_scale = SCALE * (240 / need)
    print("MUST reduce scale to", new_scale)
else:
    CX = (min(lefts)+max(rights))/2
    VX2 = int(round(CX - 90))
    print("proposed VY", VY2, "VX", VX2)
    print("covers y", VY2, VY2+240, "union", union_top, union_bot)