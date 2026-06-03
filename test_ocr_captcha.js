/**
 * Decode the user-provided base64 captcha, preprocess it, and run OCR.
 */
const { createWorker } = require('tesseract.js');
const { preprocessCaptcha } = require('./captcha_solver');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

const DATA_URI = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALkAAAAuCAYAAAB0zrinAAADGUlEQVR42u2dQY7kIAxFOWRftpcj%0A9SXmBH2M34uRSlOlrgTMt78BW2KXCsF+sY0hVGslNwL8a6vct6SEDqMV1oK85HhPX5LCui+tpGQr%0A54I3raSkIC+ptGnVVMUR8jKeQE9Odl3LlgX53lHtZSws/U/b8k7PdFucnqqgoxXk/jpvnnbwMijz%0AISOfkQ05417W3/f0Db4ebj09jE0OoiecyudbGXLmiz4yjl8iyBP0YdETAsixDuC0OUQyHZiAG2Hl%0AzbUjffLmb1H550wf2BRyJIZ81o74/PPxaCTPTw9RERONjGE6c9Umix6erv0f5jdgGyHnDqqJIMfY%0Ab7Aj5Mu87Dcwv0YHOeQQQd4J+kNZhtLXcIjLADkyQX4B82zFpqkgv+gAIu/5K+SsspVlkpUlclKf%0A6d4zM4CklxGnFKWEHMnLZRGQwwtyomdeAvJeqCI+GrgaAA6AvLEh74SZlSp4LfBtBbl6bhA97oEI%0Aen2PSZgH9HA5Nm9HAJYnUUzA2JOxWRCzQQ5SzuwJedT2Cnp9VbUZKaBOH+6Rhmww4Jkz1Mkhgvy2%0Av8yQq3LkcMgJiyZKyJW2uO1TttoUADl7P0hEaQ7jHnKmpNod2SB2NmbIZYX4EyAfnABORNOUkEcV%0AAS77xiKQWz0IywAzy9ne8yJMOC0PO6gqXd2Qz7YsgLtDTi7NMdNGT/tk+ApqO8hHUhCpJw+G3Kqb%0AzJB33BumKLYS5KMe/uaaoYUpzz0yLMhRkPuUiJrYq8H+IiwPeTsP8hgGVVtOGZOw3dIVRbWjIE+S%0AmzK+SVwF8saB3LTtQHXmzhaQe3/fuRvkLS/klG3Y4RW9TNWUkbTlIX+/v06CXGx/l9OztoKcUQU6%0ABfKWE3J6f8tDPlMuLMi1kbYgd6gSmEHvhBx7QA6cA/l6JyG7LUgZIY8ePsFg2xx/zZ48F+T7QH68%0ALHv+d2LIvf4xrl4a43iOh7ynH0fIo/Xv2Z+CJQ2/3ud0e0EeVXp7Mc5OnvWc1GplyAuIQ8bMPDI5%0AAnKTaAGv+V/W/FflyV2UewH5zv8FVOIPuepNLshPlh/UlFMBkhhnkgAAAABJRU5ErkJggg==`;

async function ocrBuffer(buf, psm, label) {
    const w = await createWorker('eng');
    await w.setParameters({
        tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        tessedit_pageseg_mode: psm,
    });
    const { data: { text, confidence } } = await w.recognize(buf);
    await w.terminate();
    const result = text.replace(/[^a-zA-Z0-9]/g, '').trim();
    console.log(`    ${label} PSM${psm}: "${result}"  conf=${Math.round(confidence)}%`);
    return result;
}

(async () => {
    console.log('=== NEW CAPTCHA READ TEST ===\n');

    // Strip data URI prefix and URL-decode, then decode base64
    const b64 = DATA_URI
        .replace(/^data:image\/png;base64,/, '')
        .replace(/%0A/g, '')   // URL-encoded newlines
        .replace(/\s+/g, '');

    const raw = Buffer.from(b64, 'base64');
    console.log(`[1] Decoded: ${raw.length} bytes`);
    fs.writeFileSync(path.join(__dirname, 'new_captcha_raw.png'), raw);
    console.log('    Saved: new_captcha_raw.png\n');

    // RAW OCR
    console.log('[2] RAW (no preprocessing):');
    for (const psm of ['6', '8', '13']) await ocrBuffer(raw, psm, '  raw');

    // PREPROCESSED OCR
    console.log('\n[3] PREPROCESSED (denoise + dilate + 4x scale):');
    let processed;
    try {
        processed = await preprocessCaptcha(raw);
        fs.writeFileSync(path.join(__dirname, 'new_captcha_processed.png'), processed);
        console.log('    Saved: new_captcha_processed.png');
        for (const psm of ['6', '8', '13']) await ocrBuffer(processed, psm, 'proc');
    } catch(e) {
        console.error('    Preprocessing error:', e.message);
    }

    console.log('\n=== DONE — open new_captcha_raw.png and new_captcha_processed.png to compare ===');
})().catch(console.error);
