const Jimp = require('jimp');

const DATA_URI = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALkAAAAuCAYAAAB0zrinAAADGUlEQVR42u2dQY7kIAxFOWRftpcj%0A9SXmBH2M34uRSlOlrgTMt78BW2KXCsF+sY0hVGslNwL8a6vct6SEDqMV1oK85HhPX5LCui+tpGQr%0A54I3raSkIC+ptGnVVMUR8jKeQE9Odl3LlgX53lHtZSws/U/b8k7PdFucnqqgoxXk/jpvnnbwMijz%0AISOfkQ05417W3/f0Db4ebj09jE0OoiecyudbGXLmiz4yjl8iyBP0YdETAsixDuC0OUQyHZiAG2Hl%0AzbUjffLmb1H550wf2BRyJIZ81o74/PPxaCTPTw9RERONjGE6c9Umix6erv0f5jdgGyHnDqqJIMfY%0Ab7Aj5Mu87Dcwv0YHOeQQQd4J+kNZhtLXcIjLADkyQX4B82zFpqkgv+gAIu/5K+SsspVlkpUlclKf%0A6d4zM4CklxGnFKWEHMnLZRGQwwtyomdeAvJeqCI+GrgaAA6AvLEh74SZlSp4LfBtBbl6bhA97oEI%0Aen2PSZgH9HA5Nm9HAJYnUUzA2JOxWRCzQQ5SzuwJedT2Cnp9VbUZKaBOH+6Rhmww4Jkz1Mkhgvy2%0Av8yQq3LkcMgJiyZKyJW2uO1TttoUADl7P0hEaQ7jHnKmpNod2SB2NmbIZYX4EyAfnABORNOUkEcV%0AAS77xiKQWz0IywAzy9ne8yJMOC0PO6gqXd2Qz7YsgLtDTi7NMdNGT/tk+ApqO8hHUhCpJw+G3Kqb%0AzJB33BumKLYS5KMe/uaaoYUpzz0yLMhRkPuUiJrYq8H+IiwPeTsP8hgGVVtOGZOw3dIVRbWjIE+S%0AmzK+SVwF8saB3LTtQHXmzhaQe3/fuRvkLS/klG3Y4RW9TNWUkbTlIX+/v06CXGx/l9OztoKcUQU6%0ABfKWE3J6f8tDPlMuLMi1kbYgd6gSmEHvhBx7QA6cA/l6JyG7LUgZIY8ePsFg2xx/zZ48F+T7QH68%0ALHv+d2LIvf4xrl4a43iOh7ynH0fIo/Xv2Z+CJQ2/3ud0e0EeVXp7Mc5OnvWc1GplyAuIQ8bMPDI5%0AAnKTaAGv+V/W/FflyV2UewH5zv8FVOIPuepNLshPlh/UlFMBkhhnkgAAAABJRU5ErkJggg==`;

(async () => {
    const raw = Buffer.from(DATA_URI.replace(/^data:image\/png;base64,/, '').replace(/%0A/g, ''), 'base64');
    const img = await Jimp.read(raw);
    const W = img.getWidth();
    const H = img.getHeight();

    // Create pure binary array just for black pixels
    const bin = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const rgba = Jimp.intToRGBA(img.getPixelColor(x, y));
            if (rgba.a > 0 && rgba.r < 50 && rgba.g < 50 && rgba.b < 50) {
                bin[y * W + x] = 1;
            }
        }
    }

    // Output Jimp image
    const out = new Jimp(W, H, 0xFFFFFFFF);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (bin[y*W+x] === 1) out.setPixelColor(0x000000FF, x, y);
        }
    }

    out.scale(4, Jimp.RESIZE_NEAREST_NEIGHBOR);
    const buf = await out.getBufferAsync(Jimp.MIME_PNG);
    require('fs').writeFileSync('debug_pure_black.png', buf);

    const { createWorker } = require('tesseract.js');
    const w = await createWorker('eng');
    await w.setParameters({
        tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        tessedit_pageseg_mode: '13',
    });
    const { data: { text } } = await w.recognize(buf);
    await w.terminate();
    console.log(`OCR Result: ${text.replace(/[^a-zA-Z0-9]/g, '').trim()}`);
})();
