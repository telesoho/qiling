from PIL import Image
import numpy as np
from pathlib import Path
tracks=Path(r"C:\Users\telesoho\prjs\my\qiling\design\anim\诗琚-吊起\tracks")
for i in [1,50,64,100,160,193]:
    a=np.array(Image.open(tracks/f"frame{i:03d}.webp").convert("RGBA"))[:,:,3]
    ys,xs=np.where(a>8)
    print(f"f{i:03d} y={ys.min()}-{ys.max()} topEdge={(a[0]>8).sum()} botEdge={(a[-1]>8).sum()}")