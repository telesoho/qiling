# -*- coding: utf-8 -*-
"""方案1：scale 锁定 211/517，抬高画布装下全序列包围盒。"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRAMES, REMBG_DIR = ROOT/"white-frames", ROOT/"white-rembg"
TRACKS, PREVIEW, STRUCT = ROOT/"tracks", ROOT/"preview", ROOT/"track_struct.json"
SRC_CANVAS, VW, FPS, EXPECTED = 720, 180, 24, 193
SCALE = 211/517
MARGIN = 6
REMBG_EXE = Path(r"C:\Users\telesoho\design-tools\Scripts\rembg.exe")
U2NET = Path(r"C:\Users\telesoho\design-tools\models")

def log(m): print(m, flush=True)

def alpha_bbox(im):
    import numpy as np
    a = np.array(im)[:,:,3]
    ys, xs = np.where(a>8)
    if len(xs)==0: return None
    return int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1

def compute_fit():
    from PIL import Image
    files = sorted(p for p in REMBG_DIR.glob("*.png") if p.stem.isdigit())
    assert len(files)==EXPECTED
    tops,bots,lefts,rights=[],[],[],[]
    for f in files:
        b=alpha_bbox(Image.open(f).convert("RGBA"))
        if not b: continue
        x0,y0,x1,y1=b
        tops.append(y0*SCALE); bots.append(y1*SCALE)
        lefts.append(x0*SCALE); rights.append(x1*SCALE)
    uh=max(bots)-min(tops); uw=max(rights)-min(lefts)
    VH = int(round(uh + 2*MARGIN))
    # keep even-ish height
    if VH % 2: VH += 1
    scaled=round(SRC_CANVAS*SCALE)
    cx=(min(lefts)+max(rights))/2
    cy=(min(tops)+max(bots))/2
    vx=int(round(cx-VW/2)); vy=int(round(cy-VH/2))
    # clamp prefer covering union
    vy=int(round(min(tops)-MARGIN))
    if vy+VH < max(bots)+MARGIN:
        vy=int(round(max(bots)+MARGIN-VH))
    fit={
        "scale":SCALE,"scaledSize":scaled,
        "viewport":{"x":vx,"y":vy,"w":VW,"h":VH},
        "frameSize":{"width":VW,"height":VH},
        "unionScaled":{"top":min(tops),"bot":max(bots),"h":uh,"w":uw},
        "margin":MARGIN,"method":"fixed_scale_0.408_taller_canvas",
        "note":f"scale锁定0.408；画布抬高为{VW}×{VH}以容纳全序列包围盒(~{uh:.1f}px+边距)",
        "standIdleScale":SCALE,
    }
    log(f"[fit] scale={SCALE:.6f} canvas={VW}x{VH} uh={uh:.1f} vp=({vx},{vy})")
    return fit, files

def step_scale():
    from PIL import Image
    fit, files = compute_fit()
    sc=fit["scaledSize"]; vx=fit["viewport"]["x"]; vy=fit["viewport"]["y"]
    VH=fit["viewport"]["h"]
    TRACKS.mkdir(parents=True,exist_ok=True); PREVIEW.mkdir(parents=True,exist_ok=True)
    outs=[]; t0=time.time()
    for i,f in enumerate(files,1):
        im=Image.open(f).convert("RGBA")
        scaled=im.resize((sc,sc), Image.Resampling.LANCZOS)
        canvas=Image.new("RGBA",(VW,VH),(0,0,0,0))
        canvas.paste(scaled,(-vx,-vy),scaled)
        canvas.save(TRACKS/f"frame{i:03d}.webp","WEBP",lossless=True,quality=100,method=6)
        outs.append(canvas)
        if i in (1,EXPECTED) or i%40==0: log(f"  wrote frame{i:03d}.webp")
    for extra in TRACKS.glob("frame*.webp"):
        try: idx=int(extra.stem.replace("frame",""))
        except: continue
        if idx>EXPECTED or extra.stat().st_size<1000: extra.unlink()
    outs[0].save(PREVIEW/"all_in_one.webp","WEBP",save_all=True,append_images=outs[1:],
                 duration=int(1000/FPS),loop=0,lossless=True,quality=100,method=4)
    idxs=[1,36,37,72,73,132,133,193]
    sheet=Image.new("RGBA",(VW*len(idxs),VH),(40,40,48,255))
    for i,idx in enumerate(idxs):
        c=outs[idx-1]; bg=Image.new("RGBA",c.size,(40,40,48,255)); bg.alpha_composite(c)
        sheet.paste(bg.convert("RGB"),(i*VW,0))
    sheet.convert("RGB").save(PREVIEW/"contact_phases.png")
    outs[0].save(PREVIEW/"frame001.png"); outs[99].save(PREVIEW/"frame100.png"); outs[-1].save(PREVIEW/"frame193.png")
    (PREVIEW/"process_meta.json").write_text(json.dumps({**fit,"frameCount":EXPECTED,"fps":FPS},indent=2,ensure_ascii=False),encoding="utf-8")
    log(f"[scale] done {time.time()-t0:.0f}s H={VH}")
    return fit

def write_struct(fit):
    prev={}
    if STRUCT.exists():
        try: prev=json.loads(STRUCT.read_text(encoding="utf-8"))
        except: pass
    VH=fit["viewport"]["h"]
    phases=prev.get("phases")
    if not phases:
        phases={
            "idle":{"label":"待机","playback":"loop","asset":{"type":"animatedWebp","src":"../../../public/pet/idle.webp","fps":24}},
            "lift":{"label":"吊起","playback":"once","holdAtEnd":True,"onHoldComplete":"hover","trigger":"pointerdown",
                    "asset":{"type":"frameSequence","dir":"tracks","pattern":"frame{NNN}.webp","zeroPad":3,"indexBase":1,"from":31,"to":72}},
            "hover":{"label":"悬空","playback":"loop","while":"pointerdown","followPointer":True,"trigger":"pointermove","enterAlso":"lift.holdAtEnd",
                     "asset":{"type":"frameSequence","dir":"tracks","pattern":"frame{NNN}.webp","zeroPad":3,"indexBase":1,"from":73,"to":132}},
            "drop":{"label":"落下","playback":"once","holdAtEnd":True,"fallback":"idle","trigger":"pointerup",
                    "asset":{"type":"frameSequence","dir":"tracks","pattern":"frame{NNN}.webp","zeroPad":3,"indexBase":1,"from":133,"to":193}},
        }
    data={
        "id":prev.get("id","shiju-pickup-hover"),
        "displayName":prev.get("displayName","诗琚·吊起悬停"),
        "description":"方案1：scale锁定0.408，画布加高以保留全序列上升位移。",
        "version":"0.5.0",
        "fps":FPS,
        "frameSize":{"width":VW,"height":VH},
        "anchor":prev.get("anchor",{"x":0.5,"y":0.12,"note":"无形线抓手约在头顶"}),
        "paths":{"preview":"preview/all_in_one.webp","struct":"track_struct.json","tracksDir":"tracks"},
        "fit":fit,
        "phases":phases,
        "interrupt":prev.get("interrupt",{
            "pointerupDuringLift":"drop","pointerupDuringHover":"drop",
            "pointerdownDuringDrop":"lift","pointerdownWhileIdle":"lift",
            "holdStillAfterLift":"enterHover","rapidClick":"liftThenDrop"}),
        "assetTypes":prev.get("assetTypes"),
        "frameCount":EXPECTED,
        "compat":{"idleWebpSize":"180x240","note":"本序列画布高于 idle.webp；运行时按 frameSize 布局，idle 相位仍可用 180×240 资源居中叠放"},
    }
    STRUCT.write_text(json.dumps(data,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    log(f"[struct] v0.5.0 {VW}x{VH}")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--skip-extract",action="store_true")
    ap.add_argument("--skip-rembg",action="store_true")
    ap.add_argument("--skip-scale",action="store_true")
    args=ap.parse_args(); log(f"ROOT={ROOT}")
    fit=step_scale() if not args.skip_scale else compute_fit()[0]
    write_struct(fit)
    log(f"ALL DONE {len(list(TRACKS.glob('frame*.webp')))}/{EXPECTED}")
if __name__=="__main__": main()