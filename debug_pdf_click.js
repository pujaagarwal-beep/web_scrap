const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
    console.log('Starting debug browser...');
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1200, height: 800 }
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    try {
        console.log('Navigating to homepage...');
        await page.goto('https://wbtenders.gov.in/nicgep/app', { waitUntil: 'networkidle2' });

        console.log('Searching for "cable"...');
        await page.waitForSelector('#SearchDescription');
        await page.type('#SearchDescription', 'cable');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#Go')
        ]);

        console.log('Clicking the first tender...');
        await page.waitForSelector('#DirectLink_0');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#DirectLink_0')
        ]);

        // Find the NIT link ID
        const nitId = await page.evaluate(() => {
            const nit = Array.from(document.querySelectorAll('a')).find(a =>
                (a.id && a.id.toLowerCase().includes('docdown')) ||
                (a.href && a.href.toLowerCase().includes('docdown')) ||
                (a.innerText && a.innerText.trim().toLowerCase().endsWith('.pdf')) ||
                (a.innerText && a.innerText.toLowerCase().includes('tendernotice'))
            );
            return nit ? nit.id : null;
        });

        if (nitId) {
            console.log('Clicking NIT link...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click(`#${nitId}`)
            ]);

            console.log('On download page. URL:', page.url());

            // Get captcha image base64 data
            const src = await page.evaluate(() => {
                const img = document.querySelector('#captchaImage');
                return img ? img.src : null;
            });

            if (src) {
                console.log('Found captcha image src.');
                const b64 = src.split(',')[1];
                const outPath = path.join(__dirname, 'captcha_base64.txt');
                fs.writeFileSync(outPath, b64);
                console.log('Saved full base64 to:', outPath);
            } else {
                console.log('No captcha image found on page!');
            }

        } else {
            console.log('No NIT link found!');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await browser.close();
        console.log('Done.');
    }
})();
