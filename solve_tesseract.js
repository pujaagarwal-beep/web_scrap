const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');

(async () => {
    try {
        console.log('Loading worker...');
        const worker = await createWorker('eng');
        
        // Set whitelist to alphanumeric characters only
        await worker.setParameters({
            tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        });
        
        console.log('Worker loaded. Reading image...');
        
        const b64Path = path.join(__dirname, 'captcha_base64.txt');
        let b64Data = fs.readFileSync(b64Path, 'utf8').trim();
        
        // URL decode
        b64Data = decodeURIComponent(b64Data);
        // Remove whitespace and newlines
        b64Data = b64Data.replace(/[\s\r\n]+/g, '');
        
        const buffer = Buffer.from(b64Data, 'base64');
        
        const { data: { text } } = await worker.recognize(buffer);
        console.log('Cleaned text:', text.trim());
        
        await worker.terminate();
    } catch (err) {
        console.error('Error:', err);
    }
})();
