const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const userDataDir = path.join(__dirname, 'chrome_user_data');

(async () => {
    console.log('Starting browser to inspect Tenders Status page...');
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: userDataDir,
        defaultViewport: { width: 1366, height: 768 }
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    try {
        const portalUrl = 'https://wbtenders.gov.in'; // Let's check wbtenders first
        console.log(`Navigating to ${portalUrl}...`);
        await page.goto(`${portalUrl}/nicgep/app`, { waitUntil: 'networkidle2' });

        // Find "Tenders Status" link
        console.log('Searching for Tenders Status link...');
        const tendersStatusLinkId = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const match = links.find(l => l.innerText && l.innerText.trim() === 'Tenders Status');
            if (match) {
                if (!match.id) match.id = 'temp_tenders_status_link';
                return match.id;
            }
            return null;
        });

        if (!tendersStatusLinkId) {
            console.log('Tenders Status link not found by innerText! Printing all link texts:');
            const linkTexts = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a')).map(l => (l.innerText || '').trim()).filter(Boolean);
            });
            console.log(linkTexts);
            return;
        }

        console.log(`Found Tenders Status link. ID: ${tendersStatusLinkId}. Clicking...`);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click(`#${tendersStatusLinkId}`)
        ]);

        console.log('Navigated to Tenders Status page. Current URL:', page.url());

        // Now inspect the form elements on the page
        const formInfo = await page.evaluate(() => {
            const selects = Array.from(document.querySelectorAll('select')).map(s => ({
                id: s.id,
                name: s.name,
                options: Array.from(s.options).map(o => ({ value: o.value, text: o.text }))
            }));

            const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
                id: i.id,
                name: i.name,
                type: i.type,
                value: i.value,
                placeholder: i.placeholder
            }));

            const images = Array.from(document.querySelectorAll('img')).map(img => ({
                id: img.id,
                src: img.src ? img.src.substring(0, 100) : ''
            }));

            const buttons = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button')).map(b => ({
                id: b.id,
                value: b.value,
                text: b.innerText || ''
            }));

            return { selects, inputs, images, buttons };
        });

        console.log('--- SELECT ELEMENTS ---');
        console.log(JSON.stringify(formInfo.selects, null, 2));

        console.log('--- INPUT ELEMENTS ---');
        console.log(JSON.stringify(formInfo.inputs, null, 2));

        console.log('--- IMAGE ELEMENTS ---');
        console.log(JSON.stringify(formInfo.images, null, 2));

        console.log('--- BUTTONS ---');
        console.log(JSON.stringify(formInfo.buttons, null, 2));

        // Take a screenshot of the form for visual verification
        const screenshotPath = path.join(__dirname, 'tenders_status_form.png');
        await page.screenshot({ path: screenshotPath });
        console.log('Saved screenshot of form to:', screenshotPath);

    } catch (err) {
        console.error('Inspection failed:', err.message);
    } finally {
        await browser.close();
    }
})();
