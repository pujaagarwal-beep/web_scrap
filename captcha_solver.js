const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');

/**
 * Clean the captcha image inside the browser using HTML5 Canvas
 * @param {object} page Puppeteer page
 * @param {number} threshold Grayscale threshold (0-255)
 */
async function cleanCaptchaInBrowser(page, threshold = 120) {
    return await page.evaluate((thresholdValue) => {
        const img = document.querySelector('#captchaImage');
        if (!img) return null;

        // 1. Draw original unscaled image to temporary canvas
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.naturalWidth;
        tempCanvas.height = img.naturalHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0);

        const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imgData.data;
        const w = tempCanvas.width;
        const h = tempCanvas.height;

        // 2. Grayscale & Binarize original unscaled image
        const binary = new Uint8Array(w * h);
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            binary[i / 4] = (gray < thresholdValue) ? 1 : 0;
        }

        // 3. Morphological Erosion (Radius 1) to remove 1px-thin lines
        const eroded = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = y * w + x;
                if (binary[idx] === 1) {
                    // Check 4-neighbors (all must be black for the pixel to survive)
                    if (binary[idx - w] === 1 && binary[idx + w] === 1 && 
                        binary[idx - 1] === 1 && binary[idx + 1] === 1) {
                        eroded[idx] = 1;
                    }
                }
            }
        }

        // 4. Morphological Dilation (Radius 1) to restore character thickness
        const dilated = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = y * w + x;
                if (eroded[idx] === 1) {
                    dilated[idx] = 1;
                    dilated[idx - w] = 1;
                    dilated[idx + w] = 1;
                    dilated[idx - 1] = 1;
                    dilated[idx + 1] = 1;
                }
            }
        }

        // 5. Write cleaned unscaled pixels back to tempCanvas
        const cleanedData = tempCtx.createImageData(w, h);
        for (let i = 0; i < cleanedData.data.length; i += 4) {
            const idx = i / 4;
            const val = (dilated[idx] === 1) ? 0 : 255;
            cleanedData.data[i] = val;     // R
            cleanedData.data[i + 1] = val; // G
            cleanedData.data[i + 2] = val; // B
            cleanedData.data[i + 3] = 255; // A
        }
        tempCtx.putImageData(cleanedData, 0, 0);

        // 6. Draw clean unscaled image to a 3x scaled canvas with crisp nearest-neighbor scaling
        const scale = 3;
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = w * scale;
        finalCanvas.height = h * scale;
        const finalCtx = finalCanvas.getContext('2d');
        
        finalCtx.imageSmoothingEnabled = false;
        finalCtx.msImageSmoothingEnabled = false;
        finalCtx.webkitImageSmoothingEnabled = false;
        
        finalCtx.drawImage(tempCanvas, 0, 0, finalCanvas.width, finalCanvas.height);

        return finalCanvas.toDataURL('image/png');
    }, threshold);
}

/**
 * Wait for the captcha image to be completely loaded in the browser
 * @param {object} page Puppeteer page
 */
async function waitForCaptchaImage(page) {
    try {
        await page.waitForSelector('#captchaImage', { visible: true, timeout: 5000 });
        // Wait for naturalWidth to be positive indicating it loaded
        await page.evaluate(async () => {
            const img = document.querySelector('#captchaImage');
            if (!img) return;
            if (img.complete && img.naturalWidth > 0) return;
            await new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 3000);
            });
        });
        // Extra short safety buffer to let page settle
        await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
        console.warn('  [Captcha] Timeout waiting for captcha image to render.');
    }
}

/**
 * Solve captcha on the page automatically
 * @param {object} page Puppeteer page
 * @returns {Promise<string>} Solved captcha string
 */
async function solveCaptcha(page) {
    let worker = null;
    try {
        // Ensure the captcha image has fully loaded before we read it
        await waitForCaptchaImage(page);

        console.log('  [Captcha] Cleaning captcha image in browser...');
        const cleanBase64 = await cleanCaptchaInBrowser(page, 125);
        if (!cleanBase64) {
            console.warn('  [Captcha] Captcha image element not found!');
            return '';
        }

        // Convert base64 data URL to buffer
        const base64Data = cleanBase64.replace(/^data:image\/png;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        // Optional: save cleaned captcha for debugging
        const debugPath = path.join(__dirname, 'last_cleaned_captcha.png');
        fs.writeFileSync(debugPath, buffer);

        console.log('  [Captcha] Initiating Tesseract OCR...');
        worker = await createWorker('eng');
        
        // Whitelist only alphanumeric characters for safety
        await worker.setParameters({
            tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        });

        const { data: { text } } = await worker.recognize(buffer);
        const solvedText = text.replace(/[^a-zA-Z0-9]/g, '').trim();
        console.log(`  [Captcha] OCR Solved: "${solvedText}"`);
        
        return solvedText;
    } catch (err) {
        console.error('  [Captcha] Error solving captcha:', err.message);
        return '';
    } finally {
        if (worker) {
            await worker.terminate();
        }
    }
}

module.exports = {
    solveCaptcha,
    cleanCaptchaInBrowser
};
