#!/usr/bin/env python3
"""
隐形水印工具（已搁置 / SHELVED — 2026-05-29）
================================================
状态：**未接入任何发布流程**。publish-all.mjs / upload-r2.mjs 都不会调用它。
      想用的时候手动跑；不想用就放着，永远不会自动执行。

为什么搁置：在纯白底/浅色主体的词图上，隐形水印做不到"逐像素完全一样"
（这是原理：可提取的水印 = 必须改像素）。归属维权本来也不依赖水印
（原始文件 + git 时间戳 + CDN 日志已是铁证），所以暂不上线。详见
memory: project_anti_scraping_plan.md。

这套已验证可用的方案（保留以备将来）：
  - 方法 dwtDctSvd（不是 dwtDct，后者在 invisible-watermark 0.2.0 里是坏的）
  - 嵌入 Y(亮度)通道，scale=70；自己做 clip 修掉库的 uint8 回卷黑点 bug
  - 感知掩蔽：纯白/近白区(亮度<232 且无纹理)完全不碰，只往主体纹理里塞
  - 解码端同样只读纹理块；裁剪后可用 resync() 暴力对齐网格恢复
  实测：白底改动=0；主体改动 max~20(藏在绒毛里)；JPEG q90/q60、缩放、
        截图均 56/56 解出；唯一弱项=纯光滑无纹理浅色物(如 cloud，~50/56，
        将来要上可加纠错码兜底)。

环境（这些库跟系统新版 numpy2/opencv4.13 不兼容，必须用独立 venv）：
    python3 -m venv tmp/wm-venv
    tmp/wm-venv/bin/pip install "numpy<2" "opencv-python==4.8.1.78" \
        "invisible-watermark==0.2.0" PyWavelets

用法：
    tmp/wm-venv/bin/python scripts/watermark-images.py embed  IN.jpg OUT.png [payload]
    tmp/wm-venv/bin/python scripts/watermark-images.py decode IMG.png        [payload]
    tmp/wm-venv/bin/python scripts/watermark-images.py batch  public/images OUTDIR [payload]
"""
import sys, os
import cv2
import numpy as np
import pywt
from imwatermark.dwtDctSvd import EmbedDwtDctSvd

DEFAULT_PAYLOAD = b"plushie"      # 想埋什么改这里：网址/版权/每图ID 皆可。56bit≈7字符
SCALE = 70
CHANNEL = 0                        # 0=Y 亮度通道
BLOCK = 4
TEX_T = 4.0                        # 纹理阈值：局部标准差低于此=平坦,不嵌
BRIGHT_CEIL = 232                  # 亮度闸：超过此亮度(近白)即使有纹理也不嵌


def _payload_bits(payload: bytes):
    return [(b >> (7 - i)) & 1 for b in payload for i in range(8)]


def _texmask(bgr):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mean = cv2.blur(g, (7, 7))
    sq = cv2.blur(g * g, (7, 7))
    std = np.sqrt(np.clip(sq - mean * mean, 0, None))
    mask = np.clip((std - TEX_T) / TEX_T, 0, 1)
    mask *= (mean < BRIGHT_CEIL).astype(np.float32)
    return cv2.blur(mask, (9, 9))


def _encode_full(bgr, bits):
    """整图嵌入(会动白底)，clip 修复 uint8 回卷。供 masked_embed 内部用。"""
    emb = EmbedDwtDctSvd(watermarks=bits, wmLen=len(bits), scales=[0, 0, 0])
    emb._scales[CHANNEL] = SCALE
    yuv = cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV).astype(np.float32)
    r, c, _ = yuv.shape
    ca, (h, v, d) = pywt.dwt2(yuv[:r // 4 * 4, :c // 4 * 4, CHANNEL], "haar")
    emb.encode_frame(ca, SCALE)
    yuv[:r // 4 * 4, :c // 4 * 4, CHANNEL] = pywt.idwt2((ca, (h, v, d)), "haar")
    return cv2.cvtColor(np.clip(yuv, 0, 255).astype(np.uint8), cv2.COLOR_YUV2BGR)


def embed(bgr, payload=DEFAULT_PAYLOAD):
    """感知掩蔽嵌入：白底/近白区零改动，只在主体纹理里打水印。"""
    bits = _payload_bits(payload)
    wm = _encode_full(bgr, bits).astype(np.float32)
    m = _texmask(bgr)[..., None]
    return np.clip(bgr.astype(np.float32) * (1 - m) + wm * m, 0, 255).astype(np.uint8)


def decode(img, payload=DEFAULT_PAYLOAD):
    """返回 (匹配bit数, 总bit数)。只统计纹理块,避开白底噪声。"""
    bits = _payload_bits(payload)
    emb = EmbedDwtDctSvd(wmLen=len(bits), scales=[0, 0, 0])
    emb._scales[CHANNEL] = SCALE
    yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV).astype(np.float32)
    r, c, _ = yuv.shape
    ca, _ = pywt.dwt2(yuv[:r // 4 * 4, :c // 4 * 4, CHANNEL], "haar")
    tm = _texmask(img)
    gr, gc = ca.shape[0] // BLOCK, ca.shape[1] // BLOCK
    bm = cv2.resize(tm, (gc, gr), interpolation=cv2.INTER_AREA)
    scores = [[] for _ in range(len(bits))]
    num = 0
    for i in range(gr):
        for j in range(gc):
            if bm[i, j] > 0.25:
                blk = ca[i * BLOCK:i * BLOCK + BLOCK, j * BLOCK:j * BLOCK + BLOCK]
                scores[num % len(bits)].append(emb.infer_dct_svd(blk, SCALE))
            num += 1
    out = [int((np.mean(s) if s else 0.5) > 0.5) for s in scores]
    return sum(a == b for a, b in zip(bits, out)), len(bits)


def resync(cropped_or_shifted, full_shape, payload=DEFAULT_PAYLOAD):
    """图被裁剪/平移后,试 8x8 像素偏移把块网格对回去,取最佳解码。"""
    H, W = full_shape[:2]
    ch, cw = cropped_or_shifted.shape[:2]
    best = 0
    for oy in range(8):
        for ox in range(8):
            canvas = np.full((H, W, 3), 255, np.uint8)
            yy, xx = min(oy, H - ch), min(ox, W - cw)
            canvas[yy:yy + ch, xx:xx + cw] = cropped_or_shifted[:H - yy, :W - xx]
            best = max(best, decode(canvas, payload)[0])
    return best


def _main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    payload = sys.argv[-1].encode() if (
        (cmd == "embed" and len(sys.argv) == 5) or
        (cmd == "decode" and len(sys.argv) == 4) or
        (cmd == "batch" and len(sys.argv) == 5)
    ) else DEFAULT_PAYLOAD

    if cmd == "embed":
        src = cv2.imread(sys.argv[2])
        cv2.imwrite(sys.argv[3], embed(src, payload))
        m, n = decode(embed(src, payload), payload)
        print(f"wrote {sys.argv[3]}  payload={payload!r}  self-decode {m}/{n}")
    elif cmd == "decode":
        img = cv2.imread(sys.argv[2])
        m, n = decode(img, payload)
        print(f"{sys.argv[2]}: {m}/{n} bits  payload={payload!r}")
    elif cmd == "batch":
        indir, outdir = sys.argv[2], sys.argv[3]
        os.makedirs(outdir, exist_ok=True)
        for name in sorted(os.listdir(indir)):
            if not name.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            src = cv2.imread(os.path.join(indir, name))
            if src is None:
                continue
            out = embed(src, payload)
            cv2.imwrite(os.path.join(outdir, name), out)
            m, n = decode(out, payload)
            flag = "" if m == n else "  <-- 低纹理,复核"
            print(f"{name:18} decode {m}/{n}{flag}")
    else:
        print(__doc__)


if __name__ == "__main__":
    _main()
