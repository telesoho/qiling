import os, sys, time, subprocess
from pathlib import Path

frames = Path(r"C:\Users\telesoho\prjs\my\qiling\design\anim\诗琚-吊起\white-frames")
out = Path(r"C:\Users\telesoho\prjs\my\qiling\design\anim\诗琚-吊起\white-rembg")
out.mkdir(parents=True, exist_ok=True)
rembg = r"C:\Users\telesoho\design-tools\Scripts\rembg.exe"
# Prefer CUDA; if OOM, fall back to CPU via env for that frame
srcs = sorted(frames.glob("*.png"))
print(f"total={len(srcs)}", flush=True)
t_all = time.time()
done = 0
failed = []
for src in srcs:
    dst = out / src.name
    if dst.exists() and dst.stat().st_size > 1000:
        done += 1
        continue
    t0 = time.time()
    env = os.environ.copy()
    # Limit CUDA memory growth a bit
    env["ORT_TENSORRT_ENGINE_CACHE_ENABLE"] = "0"
    r = subprocess.run([rembg, "i", "-m", "bria-rmbg", str(src), str(dst)], env=env, capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists() or dst.stat().st_size < 1000:
        # retry CPU
        if dst.exists():
            try: dst.unlink()
            except Exception: pass
        env2 = env.copy()
        env2["CUDA_VISIBLE_DEVICES"] = "-1"
        r = subprocess.run([rembg, "i", "-m", "bria-rmbg", str(src), str(dst)], env=env2, capture_output=True, text=True)
        mode = "cpu"
    else:
        mode = "cuda"
    ok = dst.exists() and dst.stat().st_size > 1000
    done += 1 if ok else 0
    if not ok:
        failed.append(src.name)
        print(f"FAIL {src.name} rc={r.returncode} err={r.stderr[-300:] if r.stderr else ''}", flush=True)
    else:
        print(f"OK {src.name} {mode} {time.time()-t0:.1f}s size={dst.stat().st_size}", flush=True)
print(f"DONE done={done}/{len(srcs)} failed={len(failed)} elapsed={time.time()-t_all:.1f}s", flush=True)
if failed:
    print("FAILED:", ",".join(failed), flush=True)
    sys.exit(1)
