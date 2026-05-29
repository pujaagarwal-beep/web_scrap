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

    // Forward browser console logs to Node terminal
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

    try {
        console.log('Navigating...');
        await page.goto('https://wbtenders.gov.in/nicgep/app', { waitUntil: 'networkidle2' });

        await page.waitForSelector('#SearchDescription');
        await page.type('#SearchDescription', 'cable');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#Go')
        ]);

        await page.waitForSelector('#DirectLink_0');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#DirectLink_0')
        ]);

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
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click(`#${nitId}`)
            ]);

            await page.waitForSelector('#captchaImage');
            await new Promise(r => setTimeout(r, 1000));

            await page.evaluate((thresholdValue) => {
                const img = document.querySelector('#captchaImage');
                if (!img) return null;
                
                const scale = 3;
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth * scale;
                canvas.height = img.naturalHeight * scale;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                
                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imgData.data;
                const width = canvas.width;
                const height = canvas.height;

                // 1. Binarize
                const binary = new Uint8Array(width * height);
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                    binary[i / 4] = (gray < thresholdValue) ? 1 : 0;
                }

                // 2. BFS
                const visited = new Uint8Array(width * height);
                const components = [];

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const idx = y * width + x;
                        if (binary[idx] === 1 && visited[idx] === 0) {
                            const component = [];
                            const queue = [idx];
                            visited[idx] = 1;
                            
                            let qHead = 0;
                            while (qHead < queue.length) {
                                const curr = queue[qHead++];
                                component.push(curr);
                                
                                const cy = Math.floor(curr / width);
                                const cx = curr % width;
                                
                                for (let dy = -1; dy <= 1; dy++) {
                                    for (let dx = -1; dx <= 1; dx++) {
                                        if (dy === 0 && dx === 0) continue;
                                        const ny = cy + dy;
                                        const nx = cx + dx;
                                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                                            const nidx = ny * width + nx;
                                            if (binary[nidx] === 1 && visited[nidx] === 0) {
                                                visited[nidx] = 1;
                                                queue.push(nidx);
                                            }
                                        }
                                    }
                                }
                            }
                            components.push(component.length);
                        }
                    }
                }
                console.log('All component sizes:', JSON.stringify(components.sort((a,b)=>b-a)));
            }, 125);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await browser.close();
        console.log('Done.');
    }
})();
