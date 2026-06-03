const { createWorker } = require('tesseract.js');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// PREPROCESSING PIPELINE
//
// Key discovery: GePNIC captchas have a TRANSPARENT background (alpha=0).
// Characters are dark pixels with alpha=255.
// Strategy:
//   1. Flatten transparent background to WHITE (fill with white before greyscale)
//   2. Greyscale
//   3. Contrast boost
//   4. Threshold to binary
//   5. Blob-based noise removal
//   6. Dilation (thicken strokes)
//   7. 4× nearest-neighbor upscale
// ─────────────────────────────────────────────────────────────────────────────

async function preprocessCaptcha(inputBuffer) {
    const img = await Jimp.read(inputBuffer);
    const W = img.getWidth();
    const H = img.getHeight();
    console.log(`  [Preprocess] Input: ${W}×${H}`);

    // Step 1: Create a binary array where ONLY black/dark pixels (R,G,B < 100) are kept.
    // GePNIC captchas have black text with alpha=255. Colored noise (blue/red/yellow) is ignored.
    const bin = new Uint8Array(W * H);
    let blackCount = 0;
    
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const rgba = Jimp.intToRGBA(img.getPixelColor(x, y));
            // Ignore transparent pixels and ignore any colored noise (lines/dots)
            if (rgba.a > 0 && rgba.r < 100 && rgba.g < 100 && rgba.b < 100) {
                bin[y * W + x] = 1;
                blackCount++;
            }
        }
    }
    console.log(`  [Preprocess] Extracted ${blackCount} dark text pixels. Colored noise removed.`);

    // Step 2: Dilation REMOVED
    // We found that dilating causes small letters like 's' to fill in their gaps, making them look like 'a'.
    let current = bin;

    // Step 3: Draw back to Jimp (black text on white background)
    const out = new Jimp(W, H, 0xFFFFFFFF);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (current[y*W+x] === 1) out.setPixelColor(0x000000FF, x, y);
        }
    }

    // Step 4: Scale 4× nearest-neighbor (crisp, no blur) for OCR
    out.scale(4, Jimp.RESIZE_NEAREST_NEIGHBOR);
    console.log(`  [Preprocess] Output: ${out.getWidth()}×${out.getHeight()}`);

    return out.getBufferAsync(Jimp.MIME_PNG);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUPPETEER HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function waitForCaptchaImage(page) {
    try {
        await page.waitForSelector('#captchaImage', { visible: true, timeout: 8000 });
        await page.evaluate(async () => {
            const img = document.querySelector('#captchaImage');
            if (!img) return;
            if (img.src && img.src.startsWith('data:')) return;
            if (img.complete && img.naturalWidth > 0) return;
            await new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 5000); });
        });
        await new Promise(r => setTimeout(r, 400));
    } catch (e) {
        console.warn('  [Captcha] Wait error:', e.message);
    }
}

async function screenshotCaptchaElement(page) {
    try {
        const el = await page.$('#captchaImage');
        if (!el) return null;
        return el.screenshot({ type: 'png' });
    } catch (e) {
        console.warn('  [Captcha] Screenshot failed:', e.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN: solveCaptcha
// ─────────────────────────────────────────────────────────────────────────────

async function solveCaptcha(page) {
    let worker = null;
    try {
        await waitForCaptchaImage(page);

        console.log('  [Captcha] Screenshotting #captchaImage...');
        const rawBuf = await screenshotCaptchaElement(page);
        if (!rawBuf || rawBuf.length < 100) {
            console.warn('  [Captcha] Empty screenshot!');
            return '';
        }
        console.log(`  [Captcha] Raw: ${rawBuf.length} bytes`);

        let procBuf;
        try {
            procBuf = await preprocessCaptcha(rawBuf);
        } catch (e) {
            console.warn('  [Captcha] Preprocessing failed, using raw:', e.message);
            procBuf = rawBuf;
        }

        fs.writeFileSync(path.join(__dirname, 'captcha_raw.png'), rawBuf);
        fs.writeFileSync(path.join(__dirname, 'captcha_processed.png'), procBuf);

        console.log('  [Captcha] Running Tesseract (PSM 7, no dict)...');
        worker = await createWorker('eng');
        await worker.setParameters({
            tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            tessedit_pageseg_mode: '7',
            classify_bln_numeric_mode: '1' // helps avoid f/F case swapping
        });

        const { data: { text, confidence } } = await worker.recognize(procBuf);
        const solved = text.replace(/[^a-zA-Z0-9]/g, '').trim();
        console.log(`  [Captcha] Result: "${solved}"  (conf: ${Math.round(confidence)}%)`);
        return solved;

    } catch (err) {
        console.error('  [Captcha] Error:', err.message);
        return '';
    } finally {
        if (worker) await worker.terminate();
    }
}

module.exports = { solveCaptcha, preprocessCaptcha, screenshotCaptchaElement, waitForCaptchaImage };
