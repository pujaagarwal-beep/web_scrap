const { createWorker } = require('tesseract.js');
const Jimp = require('jimp');
const fs = require('fs');

const DATA_URI = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALkAAAAuCAYAAAB0zrinAAADGUlEQVR42u2dQY7kIAxFOWRftpcj%0A9SXmBH2M34uRSlOlrgTMt78BW2KXCsF+sY0hVGslNwL8a6vct6SEDqMV1oK85HhPX5LCui+tpGQr%0A54I3raSkIC+ptGnVVMUR8jKeQE9Odl3LlgX53lHtZSws/U/b8k7PdFucnqqgoxXk/jpvnnbwMijz%0AISOfkQ05417W3/f0Db4ebj09jE0OoiecyudbGXLmiz4yjl8iyBP0YdETAsixDuC0OUQyHZiAG2Hl%0AzbUjffLmb1H550wf2BRyJIZ81o74/PPxaCTPTw9RERONjGE6c9Umix6erv0f5jdgGyHnDqqJIMfY%0Ab7Aj5Mu87Dcwv0YHOeQQQd4J+kNZhtLXcIjLADkyQX4B82zFpqkgv+gAIu/5K+SsspVlkpUlclKf%0A6d4zM4CklxGnFKWEHMnLZRGQwwtyomdeAvJeqCI+GrgaAA6AvLEh74SZlSp4LfBtBbl6bhA97oEI%0Aen2PSZgH9HA5Nm9HAJYnUUzA2JOxWRCzQQ5SzuwJedT2Cnp9VbUZKaBOH+6Rhmww4Jkz1Mkhgvy2%0Av8yQq3LkcMgJiyZKyJW2uO1TttoUADl7P0hEaQ7jHnKmpNod2SB2NmbIZYX4EyAfnABORNOUkEcV%0AAS77xiKQWz0IywAzy9ne8yJMOC0PO6gqXd2Qz7YsgLtDTi7NMdNGT/tk+ApqO8hHUhCpJw+G3Kqb%0AzJB33BumKLYS5KMe/uaaoYUpzz0yLMhRkPuUiJrYq8H+IiwPeTsP8hgGVVtOGZOw3dIVRbWjIE+S%0AmzK+SVwF8saB3LTtQHXmzhaQe3/fuRvkLS/klG3Y4RW9TNWUkbTlIX+/v06CXGx/l9OztoKcUQU6%0ABfKWE3J6f8tDPlMuLMi1kbYgd6gSmEHvhBx7QA6cA/l6JyG7LUgZIY8ePsFg2xx/zZ48F+T7QH68%0ALHv+d2LIvf4xrl4a43iOh7ynH0fIo/Xv2Z+CJQ2/3ud0e0EeVXp7Mc5OnvWc1GplyAuIQ8bMPDI5%0AAnKTaAGv+V/W/FflyV2UewH5zv8FVOIPuepNLshPlh/UlFMBkhhnkgAAAABJRU5ErkJggg==`;

async function testPipeline(minBlob, dilatePasses) {
    const raw = Buffer.from(DATA_URI.replace(/^data:image\/png;base64,/, '').replace(/%0A/g, ''), 'base64');
    const img = await Jimp.read(raw);
    const W = img.getWidth();
    const H = img.getHeight();

    const bg = new Jimp(W, H, 0xFFFFFFFF);
    bg.composite(img, 0, 0);
    const flat = bg;
    flat.greyscale();
    flat.contrast(0.5);

    const THRESHOLD = 128;
    const bin = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const rgba = Jimp.intToRGBA(flat.getPixelColor(x, y));
            bin[y * W + x] = (rgba.r < THRESHOLD) ? 1 : 0;
        }
    }

    const label = new Int32Array(W * H).fill(-1);
    let nLabel = 0;
    const sizes = [];

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (bin[i] === 1 && label[i] < 0) {
                const L = nLabel++;
                sizes.push(0);
                const Q = [i];
                label[i] = L;
                while (Q.length) {
                    const c = Q.pop();
                    sizes[L]++;
                    const cx = c % W, cy = (c / W) | 0;
                    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                        const nx = cx+dx, ny = cy+dy;
                        if (nx>=0 && nx<W && ny>=0 && ny<H) {
                            const ni = ny*W+nx;
                            if (bin[ni]===1 && label[ni]<0) {
                                label[ni] = L;
                                Q.push(ni);
                            }
                        }
                    }
                }
            }
        }
    }

    for (let i = 0; i < W*H; i++) {
        if (label[i] >= 0 && sizes[label[i]] < minBlob) {
            bin[i] = 0;
        }
    }

    let current = bin;
    for (let pass = 0; pass < dilatePasses; pass++) {
        const next = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (current[y*W+x] === 1) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const nx = x+dx, ny = y+dy;
                            if (nx>=0 && nx<W && ny>=0 && ny<H) next[ny*W+nx] = 1;
                        }
                    }
                }
            }
        }
        current = next;
    }
    const dil = current;

    const out = new Jimp(W, H, 0xFFFFFFFF);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (dil[y*W+x] === 1) out.setPixelColor(0x000000FF, x, y);
        }
    }

    out.scale(4, Jimp.RESIZE_NEAREST_NEIGHBOR);
    const buf = await out.getBufferAsync(Jimp.MIME_PNG);

    const w = await createWorker('eng');
    await w.setParameters({
        tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        tessedit_pageseg_mode: '13',
    });
    const { data: { text } } = await w.recognize(buf);
    await w.terminate();
    const result = text.replace(/[^a-zA-Z0-9]/g, '').trim();
    console.log(`Blob ${minBlob}, Dilate ${dilatePasses} -> ${result}`);
}

(async () => {
    await testPipeline(5, 0);
})();
