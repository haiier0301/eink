/* Phone GPS + Vietmap routing, drawn as one e-ink frame and sent
   through the existing image upload path. */
(() => {
    const KEY_STORAGE = 'epd-vietmap-key';
    const DISPLAY_STORAGE = 'epd-nav-display';
    const PROFILES = {
        da14585_2_13_212x104: [212, 104],
        da14585_2_13_250x128: [250, 128],
        da14585_4_2_400x300: [400, 300],
        nrf52_2_13_250x128: [250, 128],
        nrf52_2_9_296x128: [296, 128],
        nrf52_4_2_400x300: [400, 300],
        nrf52_4_2_400x300_bw1619: [400, 300],
        nrf52_7_5_800x480: [800, 480]
    };
    const PROFILE_BY_VALUE = {
        'da14585_2.13_212x104': PROFILES.da14585_2_13_212x104,
        'da14585_2.13_250x128': PROFILES.da14585_2_13_250x128,
        'da14585_4.2_400x300': PROFILES.da14585_4_2_400x300,
        'nrf52_2.13_250x128': PROFILES.nrf52_2_13_250x128,
        'nrf52_2.9_296x128': PROFILES.nrf52_2_9_296x128,
        'nrf52_4.2_400x300': PROFILES.nrf52_4_2_400x300,
        'nrf52_4.2_400x300_bw1619': PROFILES.nrf52_4_2_400x300_bw1619,
        'nrf52_7.5_800x480': PROFILES.nrf52_7_5_800x480
    };

    let watchId = null;
    let starting = false;
    let fixChain = Promise.resolve();
    let steps = [];
    let stepIndex = 0;
    let apiKey = '';
    let destinationText = '';
    let destinationPoint = null;
    let pickedRef = '';
    let pickedLabel = '';
    let travelMode = 'motorcycle';
    let suggestTimer = 0;
    let sending = false;
    let rerouteAt = 0;
    let offRouteFixes = 0;
    let displayedCue = null;
    let lastOrigin = null;
    let stopRequested = false;
    let suggestAbort = null;

    function $(id) {
        return document.getElementById(id);
    }

    function readKey() {
        return ($('nav-api-key')?.value || '').replace(/\s+/g, '');
    }

    function setStatus(message, isError = false) {
        const node = $('nav-status');
        if (!node) return;
        node.textContent = message || '';
        node.style.color = isError ? '#9a2929' : '#206b32';
    }

    function panelSize() {
        const mapped = PROFILE_BY_VALUE[$('screen-size')?.value];
        if (mapped) return { w: mapped[0], h: mapped[1] };
        const canvas = $('canvas');
        if (canvas && canvas.width >= 100 && canvas.height >= 80)
            return { w: canvas.width, h: canvas.height };
        return { w: 250, h: 128 };
    }

    function profileFor(width, height) {
        const current = $('screen-size')?.value;
        if (deviceProtocol === PROTOCOL_DA14585) {
            if (width === 212 && height === 104) return 'da14585_2.13_212x104';
            if (width === 250 && height === 128) return 'da14585_2.13_250x128';
            if (width === 400 && height === 300) return 'da14585_4.2_400x300';
        }
        if (deviceProtocol === PROTOCOL_NRF52) {
            if (width === 800 && height === 480) return 'nrf52_7.5_800x480';
            if (width === 296 && height === 128) return 'nrf52_2.9_296x128';
            if (width === 250 && height === 128) return 'nrf52_2.13_250x128';
            if (width === 400 && height === 300) {
                return current === 'nrf52_4.2_400x300_bw1619'
                    ? current
                    : 'nrf52_4.2_400x300';
            }
        }
        return PROFILE_BY_VALUE[current] ? current : null;
    }

    function pointOf(value) {
        if (!value) return null;
        const lat = typeof value.lat === 'function' ? value.lat() : value.lat;
        const lng = typeof value.lng === 'function' ? value.lng() : value.lng;
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }

    function metersBetween(a, b) {
        const earth = 6371000;
        const p1 = a.lat * Math.PI / 180;
        const p2 = b.lat * Math.PI / 180;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
        return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function formatDistance(meters) {
        const value = Math.max(0, meters);
        if (value < 950) return `${Math.max(10, Math.round(value / 10) * 10)} m`;
        const km = value / 1000;
        return `${km.toFixed(km < 10 ? 1 : 0)} km`;
    }

    function formatDuration(seconds) {
        const minutes = Math.max(1, Math.round(seconds / 60));
        if (minutes < 60) return `${minutes} phút`;
        const hours = Math.floor(minutes / 60);
        return `${hours} giờ ${minutes % 60} phút`;
    }

    function inferManeuver(maneuver, instruction) {
        const given = (maneuver || '').toLowerCase();
        if (given) return given;
        const text = (instruction || '').toLowerCase();
        if (text.includes('quay đầu') || text.includes('u-turn'))
            return text.includes('phải') || text.includes('right') ? 'uturn-right' : 'uturn-left';
        if (text.includes('đích') || text.includes('đã đến') || text.includes('arrive'))
            return 'arrive';
        if (text.includes('vòng xuyến') || text.includes('roundabout'))
            return text.includes('phải') ? 'roundabout-right' : 'roundabout-left';
        const sharp = text.includes('rẽ gắt') || text.includes('sharp');
        const slight = text.includes('rẽ nhẹ') || text.includes('slight') || text.includes('chếch');
        const left = text.includes('trái') || text.includes('left');
        const right = text.includes('phải') || text.includes('right');
        if (sharp && left) return 'turn-sharp-left';
        if (sharp && right) return 'turn-sharp-right';
        if (slight && left) return 'turn-slight-left';
        if (slight && right) return 'turn-slight-right';
        if (left) return 'turn-left';
        if (right) return 'turn-right';
        return 'straight';
    }

    function wrapLines(ctx, text, maxWidth, maxLines) {
        const words = (text || '').split(/\s+/).filter(Boolean);
        const lines = [];
        let current = '';
        const fits = value => ctx.measureText(value).width <= maxWidth;
        for (let i = 0; i < words.length && lines.length < maxLines; i++) {
            const trial = current ? `${current} ${words[i]}` : words[i];
            if (fits(trial)) {
                current = trial;
                continue;
            }
            if (current) {
                if (lines.length === maxLines - 1) {
                    let line = `${current}…`;
                    while (line.length > 1 && !fits(line)) line = line.slice(0, -1);
                    lines.push(line);
                    return lines;
                }
                lines.push(current);
                current = '';
                i -= 1;
                continue;
            }
            let word = words[i];
            const last = lines.length === maxLines - 1;
            const mark = last ? '…' : '';
            while (word.length > 1 && !fits(word + mark)) word = word.slice(0, -1);
            lines.push(word + mark);
            if (last) return lines;
        }
        if (current && lines.length < maxLines) lines.push(current);
        return lines;
    }

    let placedBoxes = [];
    let navFrame = null;
    let framePaper = '';
    let partBoxes = {};
    let partSig = {};
    let sentPartKeys = {};
    let customPositions = null;
    let drag = null;
    const LAYOUT_PRESETS = {
        side: {
            arrow: { x: 0.2, y: 0.5 },
            distance: { x: 0.4, y: 0.06 },
            instruction: { x: 0.4, y: 0.36 },
            time: { x: 0.4, y: 0.78 },
            remain: { x: 0.72, y: 0.78 }
        },
        top: {
            arrow: { x: 0.5, y: 0.24 },
            distance: { x: 0.06, y: 0.5 },
            instruction: { x: 0.06, y: 0.66 },
            time: { x: 0.06, y: 0.84 },
            remain: { x: 0.52, y: 0.84 }
        }
    };

    function displayState() {
        const scale = Number($('nav-text-scale')?.value);
        const layoutValue = $('nav-layout')?.value;
        const layout = layoutValue === 'top' || layoutValue === 'custom' ? layoutValue : 'side';
        return {
            arrow: $('nav-show-arrow')?.checked !== false,
            distance: $('nav-show-distance')?.checked !== false,
            instruction: $('nav-show-instruction')?.checked !== false,
            time: $('nav-show-time')?.checked !== false,
            remain: $('nav-show-remain')?.checked !== false,
            invert: !!$('nav-invert')?.checked,
            scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
            font: navFont(),
            layout,
            positions: customPositions,
            refresh: refreshFlags()
        };
    }

    function refreshFlags() {
        const read = (id, fallback) => {
            const node = $(id);
            return node ? node.checked : fallback;
        };
        return {
            arrow: read('nav-refresh-arrow', true),
            distance: read('nav-refresh-distance', false),
            instruction: read('nav-refresh-instruction', true),
            time: read('nav-refresh-time', false),
            remain: read('nav-refresh-remain', false)
        };
    }

    function navFont() {
        const allowed = ['Arial', 'sans-serif', 'Times New Roman', 'serif', 'monospace'];
        const value = $('nav-font')?.value;
        return allowed.includes(value) ? value : 'Arial';
    }

    function activePositions() {
        const preset = LAYOUT_PRESETS[$('nav-layout')?.value === 'top' ? 'top' : 'side'];
        if (!customPositions) return preset;
        const merged = clonePositions(preset);
        Object.keys(customPositions).forEach(key => {
            const spot = customPositions[key];
            if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) merged[key] = { x: spot.x, y: spot.y };
        });
        return merged;
    }

    function clonePositions(source) {
        const copy = {};
        Object.keys(source).forEach(key => {
            copy[key] = { x: source[key].x, y: source[key].y };
        });
        return copy;
    }

    function saveDisplay() {
        try {
            localStorage.setItem(DISPLAY_STORAGE, JSON.stringify(displayState()));
        } catch (storageError) {
            // Private browsing can reject storage; the controls still apply.
        }
    }

    function restoreDisplay() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(DISPLAY_STORAGE) || 'null');
        } catch (storageError) {
            saved = null;
        }
        if (!saved || typeof saved !== 'object') return;
        const check = (id, value) => {
            const node = $(id);
            if (node) node.checked = value !== false;
        };
        check('nav-show-arrow', saved.arrow);
        check('nav-show-distance', saved.distance);
        check('nav-show-instruction', saved.instruction);
        check('nav-show-time', saved.time);
        check('nav-show-remain', saved.remain);
        const invert = $('nav-invert');
        if (invert) invert.checked = !!saved.invert;
        const scale = $('nav-text-scale');
        if (scale && saved.scale) scale.value = String(saved.scale);
        const font = $('nav-font');
        if (font && saved.font) font.value = saved.font;
        customPositions = saved.positions && typeof saved.positions === 'object'
            ? clonePositions(saved.positions)
            : null;
        const layout = $('nav-layout');
        if (layout && saved.layout) layout.value = saved.layout;
        if (layout && customPositions && saved.layout !== 'side' && saved.layout !== 'top') layout.value = 'custom';
        if (saved.refresh && typeof saved.refresh === 'object') {
            const refreshIds = {
                arrow: 'nav-refresh-arrow',
                distance: 'nav-refresh-distance',
                instruction: 'nav-refresh-instruction',
                time: 'nav-refresh-time',
                remain: 'nav-refresh-remain'
            };
            Object.keys(refreshIds).forEach(key => {
                const node = $(refreshIds[key]);
                if (node && Object.prototype.hasOwnProperty.call(saved.refresh, key))
                    node.checked = !!saved.refresh[key];
            });
        }
    }

    function drawArrow(ctx, maneuver, cx, cy, size, color = '#000') {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(4, size * 0.13);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const reach = size * 0.42;

        function head(angle) {
            ctx.save();
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, reach * 0.75);
            ctx.lineTo(0, -reach * 0.35);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -reach);
            ctx.lineTo(reach * 0.46, -reach * 0.18);
            ctx.lineTo(-reach * 0.46, -reach * 0.18);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        if (maneuver === 'arrive') {
            ctx.strokeRect(-reach * 0.5, -reach * 0.55, reach, reach * 1.05);
            ctx.beginPath();
            ctx.arc(0, -reach * 0.05, reach * 0.16, 0, Math.PI * 2);
            ctx.fill();
        } else if (maneuver.startsWith('uturn')) {
            const right = maneuver.includes('right');
            ctx.beginPath();
            ctx.arc(right ? reach * 0.2 : -reach * 0.2, reach * 0.05, reach * 0.55,
                right ? Math.PI * 0.15 : Math.PI * 0.85,
                right ? Math.PI * 1.2 : -Math.PI * 0.2,
                !right);
            ctx.stroke();
            head(right ? 0.55 : -0.55);
        } else {
            let angle = 0;
            if (maneuver.includes('sharp') && maneuver.includes('right')) angle = Math.PI * 0.72;
            else if (maneuver.includes('sharp') && maneuver.includes('left')) angle = -Math.PI * 0.72;
            else if (maneuver.includes('slight') && maneuver.includes('right')) angle = Math.PI / 7;
            else if (maneuver.includes('slight') && maneuver.includes('left')) angle = -Math.PI / 7;
            else if (maneuver.includes('right')) angle = Math.PI / 2;
            else if (maneuver.includes('left')) angle = -Math.PI / 2;
            head(angle);
        }
        ctx.restore();
    }

    const PARTS = ['arrow', 'distance', 'instruction', 'time', 'remain'];
    const PART_LABELS = {
        arrow: 'mũi tên',
        distance: 'khoảng cách',
        instruction: 'tên đường',
        time: 'thời gian',
        remain: 'quãng đường'
    };

    function colorsOf(options) {
        return {
            ink: options.invert ? '#fff' : '#000',
            paper: options.invert ? '#000' : '#fff'
        };
    }

    function fontFamily(options) {
        return options.font.includes(' ') ? `"${options.font}"` : options.font;
    }

    function partText(id, cue, options) {
        if (!options[id]) return '';
        if (id === 'distance') return cue.distanceText || '';
        if (id === 'instruction') return cue.instruction || '';
        if (cue.placeText && (options.time || options.remain))
            return id === 'time' ? cue.placeText : '';
        if (id === 'time') return cue.timeText || (!cue.remainText ? (cue.footer || '') : '');
        if (id === 'remain') return cue.remainText || '';
        return '';
    }

    function partSignature(id, cue, options) {
        if (id === 'arrow') return options.arrow ? (cue.maneuver || 'straight') : 'off';
        return options[id] ? (partText(id, cue, options) || 'empty') : 'off';
    }

    function signaturesFor(cue) {
        const options = displayState();
        const next = {};
        PARTS.forEach(id => { next[id] = partSignature(id, cue, options); });
        return next;
    }

    function changedPartIds(cue) {
        const next = signaturesFor(cue);
        const ids = PARTS.filter(id => next[id] !== partSig[id]);
        partSig = next;
        return ids;
    }

    function padBox(box, pad = 3) {
        return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
    }

    function intersects(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function measureTextPart(ctx, id, text, size, bold, positions, options, w, h) {
        const spot = positions[id];
        if (!spot || !text) return null;
        ctx.font = `${bold ? 'bold ' : ''}${size}px ${fontFamily(options)}`;
        const x = Math.max(4, Math.min(w - 12, spot.x * w));
        const y = Math.max(4, Math.min(h - size - 4, spot.y * h));
        const maxWidth = Math.max(24, w - x - 6);
        const lineHeight = size + 2;
        const room = Math.max(1, Math.floor((h - y - 4) / lineHeight));
        const maxLines = Math.max(1, Math.min(id === 'instruction' ? (h <= 140 ? 3 : 4) : 2, room));
        const lines = wrapLines(ctx, text, maxWidth, maxLines);
        let widest = 8;
        lines.forEach(line => { widest = Math.max(widest, ctx.measureText(line).width); });
        return { id, x, y, w: widest, h: Math.max(size, lines.length * lineHeight), lines, size, bold };
    }

    function measureArrow(cue, options, positions, w, h) {
        if (!options.arrow || !positions.arrow) return null;
        const arrowSize = Math.max(28, Math.round(Math.min(h * 0.62, w * 0.34) * Math.min(options.scale, 1.15)));
        const cx = Math.max(arrowSize / 2, Math.min(w - arrowSize / 2, positions.arrow.x * w));
        const cy = Math.max(arrowSize / 2, Math.min(h - arrowSize / 2, positions.arrow.y * h));
        return {
            id: 'arrow',
            x: cx - arrowSize / 2,
            y: cy - arrowSize / 2,
            w: arrowSize,
            h: arrowSize,
            cx,
            cy,
            drawSize: arrowSize * 0.82,
            maneuver: cue.maneuver || 'straight'
        };
    }

    function measureParts(ctx, cue, options, positions, w, h) {
        const compact = h <= 140;
        const scale = options.scale;
        const distanceSize = Math.max(16, Math.round((compact ? h * 0.24 : h * 0.22) * scale));
        const instructionSize = Math.max(12, Math.round((compact ? h * 0.13 : h * 0.075) * scale));
        const footerSize = Math.max(11, Math.round((compact ? 11 : h * 0.055) * scale));
        const instructionDrawSize = options.distance && cue.distanceText
            ? instructionSize
            : Math.max(instructionSize, Math.round(distanceSize * 0.72));
        return {
            arrow: measureArrow(cue, options, positions, w, h),
            distance: measureTextPart(ctx, 'distance', partText('distance', cue, options), distanceSize, true, positions, options, w, h),
            instruction: measureTextPart(ctx, 'instruction', partText('instruction', cue, options), instructionDrawSize, true, positions, options, w, h),
            time: measureTextPart(ctx, 'time', partText('time', cue, options), footerSize, false, positions, options, w, h),
            remain: measureTextPart(ctx, 'remain', partText('remain', cue, options), footerSize, false, positions, options, w, h)
        };
    }

    function paintMeasured(ctx, id, part, ink, options) {
        if (!part) return;
        if (id === 'arrow') {
            drawArrow(ctx, part.maneuver, part.cx, part.cy, part.drawSize, ink);
            return;
        }
        ctx.fillStyle = ink;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = `${part.bold ? 'bold ' : ''}${part.size}px ${fontFamily(options)}`;
        part.lines.forEach((line, index) => ctx.fillText(line, part.x, part.y + index * (part.size + 2)));
    }

    function snapPixels(ctx, x, y, width, height, canvasW, canvasH) {
        x = Math.max(0, Math.floor(x));
        y = Math.max(0, Math.floor(y));
        width = Math.min(canvasW - x, Math.ceil(width));
        height = Math.min(canvasH - y, Math.ceil(height));
        if (width <= 0 || height <= 0) return;
        // The panel treats any pixel above 0 as white, so gray antialiasing
        // would vanish. Snap the touched region to pure black and white.
        const image = ctx.getImageData(x, y, width, height);
        const data = image.data;
        for (let i = 0; i < data.length; i += 4) {
            const dark = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 170;
            const value = dark ? 0 : 255;
            data[i] = data[i + 1] = data[i + 2] = value;
            data[i + 3] = 255;
        }
        ctx.putImageData(image, x, y);
    }

    function rememberBoxes(measured) {
        partBoxes = {};
        placedBoxes = [];
        PARTS.forEach(id => {
            const part = measured[id];
            if (!part) {
                partBoxes[id] = null;
                return;
            }
            const box = { id, x: part.x, y: part.y, w: part.w, h: part.h };
            partBoxes[id] = box;
            placedBoxes.push(box);
        });
    }

    function rebuildFrame(w, h, paper) {
        navFrame = document.createElement('canvas');
        navFrame.width = w;
        navFrame.height = h;
        framePaper = paper;
        partBoxes = {};
        const ctx = navFrame.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = paper;
        ctx.fillRect(0, 0, w, h);
        return ctx;
    }

    function paintAll(cue) {
        const { w, h } = panelSize();
        const options = displayState();
        const { ink, paper } = colorsOf(options);
        const ctx = rebuildFrame(w, h, paper);
        const measured = measureParts(ctx, cue, options, activePositions(), w, h);
        PARTS.forEach(id => paintMeasured(ctx, id, measured[id], ink, options));
        snapPixels(ctx, 0, 0, w, h, w, h);
        rememberBoxes(measured);
        partSig = signaturesFor(cue);
    }

    function clearBox(ctx, box, paper, w, h) {
        const area = padBox(box);
        const x = Math.max(0, Math.floor(area.x));
        const y = Math.max(0, Math.floor(area.y));
        const right = Math.min(w, Math.ceil(area.x + area.w));
        const bottom = Math.min(h, Math.ceil(area.y + area.h));
        if (right <= x || bottom <= y) return null;
        ctx.fillStyle = paper;
        ctx.fillRect(x, y, right - x, bottom - y);
        return { x, y, w: right - x, h: bottom - y };
    }

    function refreshParts(cue, ids) {
        if (!Array.isArray(ids)) {
            paintAll(cue);
            return;
        }
        const { w, h } = panelSize();
        const options = displayState();
        const { ink, paper } = colorsOf(options);
        if (!navFrame || navFrame.width !== w || navFrame.height !== h || framePaper !== paper) {
            paintAll(cue);
            return;
        }
        const ctx = navFrame.getContext('2d', { willReadFrequently: true });
        const measured = measureParts(ctx, cue, options, activePositions(), w, h);
        const regions = [];
        ids.forEach(id => {
            const cleared = partBoxes[id] ? clearBox(ctx, partBoxes[id], paper, w, h) : null;
            if (cleared) regions.push(cleared);
            if (measured[id]) regions.push(padBox(measured[id]));
        });
        const redraw = new Set(ids);
        PARTS.forEach(id => {
            const part = measured[id];
            if (!part) return;
            const box = { x: part.x, y: part.y, w: part.w, h: part.h };
            if (regions.some(region => intersects(padBox(box), region))) redraw.add(id);
        });
        PARTS.forEach(id => {
            if (redraw.has(id)) paintMeasured(ctx, id, measured[id], ink, options);
        });
        redraw.forEach(id => {
            if (measured[id]) regions.push(padBox(measured[id]));
        });
        if (regions.length) {
            let x0 = w;
            let y0 = h;
            let x1 = 0;
            let y1 = 0;
            regions.forEach(region => {
                x0 = Math.min(x0, region.x);
                y0 = Math.min(y0, region.y);
                x1 = Math.max(x1, region.x + region.w);
                y1 = Math.max(y1, region.y + region.h);
            });
            snapPixels(ctx, x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4, w, h);
        }
        rememberBoxes(measured);
    }

    function showCue(cue, partIds) {
        displayedCue = cue;
        refreshParts(cue, partIds);
        if (navFrame) showCanvas(navFrame);
    }

    function partSendKey(id, cue) {
        const flags = refreshFlags();
        if (!flags[id]) return null;
        if (id === 'arrow') return cue.maneuver || 'straight';
        if (id === 'instruction') return cue.instruction || '';
        if (id === 'distance') return 'd' + distanceBucket(cue.distanceMeters || 0);
        if (id === 'remain') return 'r' + distanceBucket(cue.remainMeters || 0);
        if (id === 'time') return 't' + Math.max(0, Math.round((cue.timeSeconds || 0) / 60));
        return null;
    }

    function partsDueForSend(cue) {
        return PARTS.filter(id => {
            const key = partSendKey(id, cue);
            return key !== null && sentPartKeys[id] !== key;
        });
    }

    function rememberSendKeys(cue) {
        PARTS.forEach(id => {
            const key = partSendKey(id, cue);
            if (key !== null) sentPartKeys[id] = key;
        });
    }

    function showCanvas(canvas) {
        const preview = $('nav-preview');
        if (!preview) return;
        if (preview.width !== canvas.width) preview.width = canvas.width;
        if (preview.height !== canvas.height) preview.height = canvas.height;
        preview.getContext('2d').drawImage(canvas, 0, 0);
    }

    function sampleCue() {
        return {
            maneuver: 'turn-left',
            instruction: 'Rẽ trái vào đường Nguyễn Huệ',
            distanceText: '120 m',
            distanceMeters: 120,
            timeText: 'Còn 18 phút',
            timeSeconds: 18 * 60,
            remainText: '4.6 km',
            remainMeters: 4600,
            footer: 'Còn 18 phút · 4.6 km'
        };
    }

    function stepPoints(step) {
        const path = (step.path || []).map(pointOf).filter(Boolean);
        if (path.length >= 2) return path;
        const start = pointOf(step.start);
        const end = pointOf(step.end);
        return [start, end].filter(Boolean);
    }

    function projectOnto(here, path) {
        if (!path.length) return { cross: Infinity, remain: Infinity };
        if (path.length === 1) {
            const distance = metersBetween(here, path[0]);
            return { cross: distance, remain: distance };
        }
        const lengths = [];
        for (let i = 1; i < path.length; i++) lengths.push(metersBetween(path[i - 1], path[i]));
        const total = lengths.reduce((sum, length) => sum + length, 0);
        let bestCross = Infinity;
        let bestRemain = total;
        let walked = 0;
        const cos = Math.cos(here.lat * Math.PI / 180) || 1;
        for (let i = 1; i < path.length; i++) {
            const a = path[i - 1];
            const b = path[i];
            const length = lengths[i - 1] || 0.001;
            const ax = a.lng * cos;
            const ay = a.lat;
            const bx = b.lng * cos;
            const by = b.lat;
            const dx = bx - ax;
            const dy = by - ay;
            const denom = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((here.lng * cos - ax) * dx + (here.lat - ay) * dy) / denom));
            const cross = metersBetween(here, { lat: ay + dy * t, lng: (ax + dx * t) / cos });
            if (cross < bestCross) {
                bestCross = cross;
                bestRemain = Math.max(0, total - (walked + length * t));
            }
            walked += length;
        }
        return { cross: bestCross, remain: bestRemain };
    }

    function locate(here) {
        let best = { index: stepIndex, cross: Infinity, remain: Infinity };
        const from = Math.max(0, stepIndex - 1);
        for (let index = from; index < steps.length; index++) {
            const projected = projectOnto(here, stepPoints(steps[index]));
            const preferCurrent = index === stepIndex ? 0 : 12;
            if (projected.cross + preferCurrent < best.cross) {
                best = { index, cross: projected.cross, remain: projected.remain };
            }
        }
        return best;
    }

    function cueFor(index, remainMeters) {
        const step = steps[index];
        if (!step) return sampleCue();
        if (!Number.isFinite(remainMeters)) remainMeters = step.distance || 0;
        let meters = remainMeters;
        let seconds = step.distance > 0 ? step.duration * (remainMeters / step.distance) : 0;
        for (let i = index + 1; i < steps.length; i++) {
            meters += steps[i].distance;
            seconds += steps[i].duration;
        }
        const arrived = index === steps.length - 1 && remainMeters < 35;
        return {
            maneuver: arrived ? 'arrive' : inferManeuver(step.maneuver, step.instruction),
            instruction: arrived ? 'Đã đến nơi' : step.instruction,
            distanceText: arrived ? '' : formatDistance(remainMeters),
            distanceMeters: arrived ? 0 : remainMeters,
            timeText: arrived ? '' : `Còn ${formatDuration(seconds)}`,
            timeSeconds: arrived ? 0 : seconds,
            remainText: arrived ? '' : formatDistance(meters),
            remainMeters: arrived ? 0 : meters,
            placeText: arrived ? destinationText : '',
            footer: arrived ? destinationText : `Còn ${formatDuration(seconds)} · ${formatDistance(meters)}`
        };
    }

    function renderStepList(activeIndex) {
        const list = $('nav-steps');
        if (!list) return;
        list.replaceChildren();
        steps.slice(activeIndex, activeIndex + 6).forEach((step, offset) => {
            const item = document.createElement('li');
            item.textContent = `${formatDistance(step.distance)} · ${step.instruction}`;
            if (offset === 0) item.style.fontWeight = '700';
            list.appendChild(item);
        });
    }

    function distanceBucket(meters) {
        if (meters < 80) return 0;
        if (meters < 150) return 80;
        if (meters < 300) return 150;
        if (meters < 600) return 300;
        if (meters < 1000) return 600;
        return Math.round(meters / 500) * 500;
    }

    async function sendCurrentPreview(partIds) {
        if (!displayedCue) showCue(sampleCue());
        else if (!navFrame) showCue(displayedCue);
        const canvas = navFrame;
        if (sending || window.countdownOperationBusy || clockImageUploadBusy || da14585ModeSwitchBusy)
            throw new Error('Đang có thao tác Bluetooth khác. Hãy đợi xong rồi gửi lại.');
        if (typeof gattServer === 'undefined' || !gattServer?.connected)
            throw new Error('Hãy kết nối e-ink ở tab cài đặt trước.');
        const profile = profileFor(canvas.width, canvas.height);
        const select = $('screen-size');
        if (profile && select) select.value = profile;
        sending = true;
        clockImageUploadBusy = true;
        if (typeof updateClockImageAvailability === 'function') updateClockImageAvailability();
        try {
            const target = $('canvas');
            target.width = canvas.width;
            target.height = canvas.height;
            target.getContext('2d').drawImage(canvas, 0, 0);
            if (typeof resetQuickEditorOverlay === 'function') resetQuickEditorOverlay(true);
            const partial = Array.isArray(partIds) && partIds.length && partIds.length < PARTS.length;
            const names = partial ? partIds.map(id => PART_LABELS[id]).join(', ') : '';
            setStatus(partial ? `Đang làm mới ${names}...` : 'Đang gửi mặt chỉ đường lên e-ink...');
            await upload_image();
            setStatus(partial ? `Đã làm mới ${names}.` : 'Đã gửi mặt chỉ đường.');
            if (typeof addLog === 'function')
                addLog(partial ? `Chỉ đường: đã làm mới ${names}.` : 'Chỉ đường: đã gửi một mặt lên e-ink.');
        } finally {
            sending = false;
            clockImageUploadBusy = false;
            if (typeof updateClockImageAvailability === 'function') updateClockImageAvailability();
        }
    }

    async function vietmapGet(url, signal) {
        let response;
        try {
            response = await fetch(url, { signal });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // A rejected key comes back as 401 with no CORS header, so the
            // browser reports the same "Failed to fetch" as a dead network.
            let reachable = false;
            try {
                const probe = await fetch(url, { mode: 'no-cors', signal });
                reachable = probe.type === 'opaque';
            } catch (probeError) {
                if (probeError.name === 'AbortError') throw probeError;
            }
            throw new Error(reachable
                ? 'Vietmap từ chối khóa. Hãy dán lại Services key, không kèm dấu cách.'
                : 'Không gọi được Vietmap. Kiểm tra mạng.');
        }
        if (response.status === 401)
            throw new Error('Khóa Vietmap không đúng. Hãy dùng Services key, không phải khóa bản đồ.');
        if (response.status === 423)
            throw new Error('Khóa Vietmap hết hạn mức hoặc chưa bật API này.');
        const data = await response.json().catch(() => null);
        if (!response.ok)
            throw new Error(data?.messages || data?.message || `Vietmap lỗi ${response.status}`);
        return data;
    }

    function decodePolyline(encoded) {
        const points = [];
        let index = 0;
        let lat = 0;
        let lng = 0;
        while (index < encoded.length) {
            let result = 0;
            let shift = 0;
            let byte = 0;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);
            result = 0;
            shift = 0;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);
            points.push({ lat: lat / 1e5, lng: lng / 1e5 });
        }
        return points;
    }

    function pathFromPoints(points) {
        if (typeof points === 'string') return decodePolyline(points);
        if (points && Array.isArray(points.coordinates)) return pathFromPoints(points.coordinates);
        if (!Array.isArray(points)) return [];
        return points.map(pair => {
            if (!Array.isArray(pair)) return pointOf(pair);
            const first = Number(pair[0]);
            const second = Number(pair[1]);
            if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
            return Math.abs(first) > 90 ? { lat: second, lng: first } : { lat: first, lng: second };
        }).filter(Boolean);
    }

    function maneuverFromSign(sign) {
        return {
            '-8': 'uturn-left',
            '-7': 'turn-slight-left',
            '-3': 'turn-sharp-left',
            '-2': 'turn-left',
            '-1': 'turn-slight-left',
            '0': 'straight',
            '1': 'turn-slight-right',
            '2': 'turn-right',
            '3': 'turn-sharp-right',
            '4': 'arrive',
            '5': 'straight',
            '6': 'roundabout-right',
            '7': 'turn-slight-right',
            '8': 'uturn-right'
        }[String(sign)] || 'straight';
    }

    function instructionFrom(step, maneuver) {
        const text = (step.text || '').trim();
        const street = (step.street_name || '').trim();
        const verb = {
            'uturn-left': 'Quay đầu',
            'uturn-right': 'Quay đầu',
            'turn-sharp-left': 'Rẽ gắt trái',
            'turn-left': 'Rẽ trái',
            'turn-slight-left': 'Rẽ nhẹ trái',
            straight: 'Đi thẳng',
            'turn-slight-right': 'Rẽ nhẹ phải',
            'turn-right': 'Rẽ phải',
            'turn-sharp-right': 'Rẽ gắt phải',
            arrive: 'Đã đến nơi',
            'roundabout-right': 'Vào vòng xuyến'
        }[maneuver] || 'Đi tiếp';
        if (maneuver === 'arrive') return text || verb;
        const hasVerb = /rẽ|quay|thẳng|tiếp|vòng|đích|đến/i.test(text);
        if (text && hasVerb) return text;
        const name = street || text;
        return name ? `${verb} vào ${name}` : verb;
    }

    function routeError(data) {
        const codes = {
            ZERO_RESULTS: 'Không tìm được đường cho loại xe này.',
            OVER_DAILY_LIMIT: 'Khóa Vietmap đã hết lượt trong ngày.',
            INVALID_REQUEST: 'Yêu cầu chỉ đường không hợp lệ.',
            MAX_POINTS_EXCEED: 'Quá nhiều điểm trên lộ trình.'
        };
        return codes[data.code] || data.messages || `Vietmap: ${data.code || 'lỗi'}`;
    }

    async function placeFromRef(ref, label) {
        const place = await vietmapGet('https://maps.vietmap.vn/api/place/v4?' + new URLSearchParams({
            apikey: apiKey,
            refid: ref
        }));
        const lat = Number(place.lat);
        const lng = Number(place.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
            throw new Error('Vietmap không trả tọa độ của địa điểm.');
        destinationPoint = { lat, lng };
        destinationText = place.display || label || destinationText;
        pickedRef = ref;
        const field = $('nav-destination');
        if (field && destinationText) field.value = destinationText;
        pickedLabel = field?.value || destinationText;
        return destinationPoint;
    }

    async function resolveDestination(origin) {
        const typed = ($('nav-destination')?.value || '').trim();
        if (!typed) throw new Error('Hãy nhập điểm đến.');
        if (pickedRef && pickedLabel === typed && destinationPoint) return destinationPoint;
        const params = new URLSearchParams({ apikey: apiKey, text: typed, display_type: '1' });
        if (origin) params.set('focus', `${origin.lat},${origin.lng}`);
        const results = await vietmapGet('https://maps.vietmap.vn/api/search/v4?' + params);
        const first = Array.isArray(results) ? results[0] : null;
        if (!first?.ref_id) throw new Error('Không tìm thấy địa điểm trên Vietmap.');
        return placeFromRef(first.ref_id, first.display || typed);
    }

    async function requestRoute(origin) {
        const params = new URLSearchParams();
        params.set('apikey', apiKey);
        params.append('point', `${origin.lat},${origin.lng}`);
        params.append('point', `${destinationPoint.lat},${destinationPoint.lng}`);
        params.set('vehicle', travelMode === 'car' ? 'car' : 'motorcycle');
        params.set('points_encoded', 'false');
        params.set('alternative', 'false');
        const data = await vietmapGet('https://maps.vietmap.vn/api/route/v4?' + params);
        if (data.code && data.code !== 'OK') throw new Error(routeError(data));
        if (!data.paths || !data.paths[0]) throw new Error('Vietmap không trả lộ trình.');
        return data.paths[0];
    }

    function adoptRoute(path) {
        const geometry = pathFromPoints(path.points);
        if (geometry.length < 2) throw new Error('Vietmap không trả hình dạng đường.');
        const nextSteps = (path.instructions || []).map(step => {
            const start = step.interval?.[0] ?? 0;
            const end = step.interval?.[1] ?? start;
            const slice = geometry.slice(Math.max(0, start), Math.max(start, end) + 1);
            const maneuver = maneuverFromSign(step.sign);
            return {
                instruction: instructionFrom(step, maneuver),
                maneuver,
                distance: step.distance || 0,
                duration: (step.time || 0) / 1000,
                path: slice,
                start: slice[0] || null,
                end: slice[slice.length - 1] || null
            };
        });
        if (!nextSteps.length) throw new Error('Lộ trình không có bước chỉ dẫn.');
        steps = nextSteps;
        stepIndex = 0;
        sentPartKeys = {};
        offRouteFixes = 0;
        renderStepList(0);
    }

    function geoMessage(error) {
        if (error?.code === 1) return 'Chrome chưa được phép lấy vị trí. Hãy bật định vị rồi thử lại.';
        if (error?.code === 3) return 'Hết thời gian chờ vị trí. Ra chỗ thoáng hơn rồi thử lại.';
        return 'Không xác định được vị trí.';
    }

    async function publishFix(here, forceUpload) {
        lastOrigin = here;
        const place = locate(here);
        const limit = travelMode === 'motorcycle' ? 55 : 70;
        if (place.cross > limit) {
            offRouteFixes += 1;
            if (offRouteFixes >= 3 && Date.now() - rerouteAt > 20000) {
                rerouteAt = Date.now();
                setStatus('Lệch lộ trình, đang tính lại đường...');
                const route = await requestRoute(here);
                adoptRoute(route);
                if (typeof addLog === 'function') addLog('Chỉ đường: đã tính lại lộ trình.');
            }
        } else {
            offRouteFixes = 0;
        }
        const active = locate(here);
        stepIndex = active.index;
        const cue = cueFor(stepIndex, active.remain);
        const previewIds = changedPartIds(cue);
        if (previewIds.length) showCue(cue, previewIds);
        else displayedCue = cue;
        renderStepList(stepIndex);
        const einkIds = partsDueForSend(cue);
        const shouldSend = forceUpload || einkIds.length > 0;
        const einkReady = typeof gattServer !== 'undefined' && gattServer?.connected;
        if (sending || !shouldSend) {
            setStatus(`${cue.distanceText} · ${cue.instruction}`);
            return;
        }
        if (!einkReady) {
            setStatus('Đã có chỉ dẫn. Kết nối e-ink rồi bấm “Gửi mặt đang xem lên e-ink”.');
            return;
        }
        try {
            await sendCurrentPreview(forceUpload ? null : einkIds);
            rememberSendKeys(cue);
        } catch (error) {
            setStatus(error.message || String(error), true);
            if (typeof addLog === 'function') addLog('Chỉ đường: ' + (error.message || error));
        }
    }

    async function startNavigation() {
        if (watchId !== null || starting) return;
        starting = true;
        try {
            await beginNavigation();
        } finally {
            starting = false;
        }
    }

    async function beginNavigation() {
        apiKey = readKey();
        travelMode = $('nav-mode')?.value || 'motorcycle';
        if (!apiKey) {
            setStatus('Hãy dán khóa Vietmap trước.', true);
            return;
        }
        if (!($('nav-destination')?.value || '').trim()) {
            setStatus('Hãy nhập điểm đến.', true);
            return;
        }
        if (!navigator.geolocation) {
            setStatus('Trình duyệt này không cung cấp vị trí.', true);
            return;
        }
        try {
            localStorage.setItem(KEY_STORAGE, apiKey);
        } catch (storageError) {
            // Private browsing can reject storage; the field still holds the key.
        }
        stopRequested = false;
        const origin = await currentPosition();
        if (stopRequested) return;
        setStatus('Đang tìm địa điểm...');
        await resolveDestination(origin);
        if (stopRequested) return;
        setStatus('Đang tính lộ trình Vietmap...');
        adoptRoute(await requestRoute(origin));
        if (stopRequested) return;
        await publishFix(origin, true);
        if (stopRequested) return;
        watchId = navigator.geolocation.watchPosition(position => {
            const here = positionPoint(position);
            fixChain = fixChain.then(() => publishFix(here, false)).catch(error => {
                setStatus(error.message || String(error), true);
            });
        }, error => {
            setStatus(geoMessage(error), true);
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 });
    }

    function positionPoint(position) {
        return {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
    }

    function currentPosition() {
        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
                position => resolve(positionPoint(position)),
                error => reject(new Error(geoMessage(error))),
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
            );
        });
    }

    function hideSuggestions() {
        const list = $('nav-suggestions');
        if (!list) return;
        list.replaceChildren();
        list.hidden = true;
    }

    async function suggestDestination() {
        const text = ($('nav-destination')?.value || '').trim();
        apiKey = readKey();
        if (text !== pickedLabel) {
            pickedRef = '';
            destinationPoint = null;
        }
        if (!apiKey || text.length < 2) {
            hideSuggestions();
            return;
        }
        suggestAbort?.abort();
        suggestAbort = new AbortController();
        const params = new URLSearchParams({ apikey: apiKey, text, display_type: '1' });
        if (lastOrigin) params.set('focus', `${lastOrigin.lat},${lastOrigin.lng}`);
        const results = await vietmapGet(
            'https://maps.vietmap.vn/api/autocomplete/v4?' + params,
            suggestAbort.signal
        );
        const list = $('nav-suggestions');
        if (!list) return;
        list.replaceChildren();
        (Array.isArray(results) ? results : []).slice(0, 5).forEach(item => {
            const row = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = item.display || item.name || item.address || '';
            button.addEventListener('click', () => {
                hideSuggestions();
                placeFromRef(item.ref_id, button.textContent).catch(error => {
                    setStatus(error.message || String(error), true);
                });
            });
            row.appendChild(button);
            list.appendChild(row);
        });
        list.hidden = list.children.length === 0;
    }

    function stopNavigation() {
        stopRequested = true;
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        setStatus('Đã dừng theo dõi. Màn e-ink giữ mặt chỉ đường cuối.');
    }

    function canvasPoint(event, canvas) {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width || canvas.width;
        const height = rect.height || canvas.height;
        return {
            x: (event.clientX - rect.left) * canvas.width / width,
            y: (event.clientY - rect.top) * canvas.height / height
        };
    }

    function bindPreviewDrag() {
        const preview = $('nav-preview');
        if (!preview) return;
        preview.addEventListener('pointerdown', event => {
            const point = canvasPoint(event, preview);
            const hit = [...placedBoxes].reverse().find(box =>
                point.x >= box.x - 10 && point.x <= box.x + box.w + 10 &&
                point.y >= box.y - 10 && point.y <= box.y + box.h + 10);
            if (!hit) return;
            event.preventDefault();
            if (!customPositions) customPositions = clonePositions(activePositions());
            const spot = customPositions[hit.id];
            if (!spot) return;
            drag = {
                id: hit.id,
                dx: point.x - spot.x * preview.width,
                dy: point.y - spot.y * preview.height
            };
            if (preview.setPointerCapture) preview.setPointerCapture(event.pointerId);
            preview.classList.add('dragging');
            const select = $('nav-layout');
            if (select && select.value !== 'custom') select.value = 'custom';
        });
        preview.addEventListener('pointermove', event => {
            if (!drag || !customPositions?.[drag.id]) return;
            const point = canvasPoint(event, preview);
            customPositions[drag.id].x = Math.max(0, Math.min(0.96, (point.x - drag.dx) / preview.width));
            customPositions[drag.id].y = Math.max(0, Math.min(0.92, (point.y - drag.dy) / preview.height));
            showCue(displayedCue || sampleCue(), [drag.id]);
        });
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            preview.classList.remove('dragging');
            saveDisplay();
        };
        preview.addEventListener('pointerup', endDrag);
        preview.addEventListener('pointercancel', endDrag);
    }

    window.refreshNavPreview = function () {
        showCue(displayedCue || sampleCue());
    };

    window.refreshNavParts = function (ids, cue) {
        showCue(cue || displayedCue || sampleCue(), Array.isArray(ids) ? ids : null);
    };

    window.showNavOnEink = async function (cue, send = false) {
        showCue({
            maneuver: inferManeuver(cue?.maneuver, cue?.instruction),
            instruction: cue?.instruction || 'Đi thẳng',
            distanceText: cue?.distanceText || '',
            footer: cue?.footer || ''
        });
        if (send) await sendCurrentPreview();
    };

    document.addEventListener('DOMContentLoaded', () => {
        const keyField = $('nav-api-key');
        try {
            if (keyField) keyField.value = localStorage.getItem(KEY_STORAGE) || '';
        } catch (storageError) {
            // Leave the field empty when storage is blocked.
        }
        restoreDisplay();
        showCue(sampleCue());
        $('nav-layout')?.addEventListener('change', () => {
            const value = $('nav-layout').value;
            if (value === 'custom') {
                if (!customPositions) customPositions = clonePositions(activePositions());
            } else {
                customPositions = null;
            }
        });
        $('nav-display')?.addEventListener('change', () => {
            saveDisplay();
            window.refreshNavPreview();
        });
        bindPreviewDrag();
        $('nav-preview-btn')?.addEventListener('click', () => {
            showCue(sampleCue());
            setStatus('Đây là mặt mẫu. Bấm gửi để đưa đúng ảnh này lên e-ink.');
        });
        $('nav-send-preview')?.addEventListener('click', () => {
            sendCurrentPreview().catch(error => setStatus(error.message || String(error), true));
        });
        $('nav-start')?.addEventListener('click', () => {
            startNavigation().catch(error => setStatus(error.message || String(error), true));
        });
        $('nav-stop')?.addEventListener('click', stopNavigation);
        $('nav-destination')?.addEventListener('focus', () => {
            if (lastOrigin || !navigator.geolocation) return;
            navigator.geolocation.getCurrentPosition(position => {
                lastOrigin = positionPoint(position);
            }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
        });
        $('nav-destination')?.addEventListener('input', () => {
            clearTimeout(suggestTimer);
            suggestTimer = setTimeout(() => {
                suggestDestination().catch(error => {
                    if (error.name === 'AbortError') return;
                    hideSuggestions();
                    setStatus(error.message || String(error), true);
                });
            }, 300);
        });
        $('screen-size')?.addEventListener('change', () => window.refreshNavPreview());
    });
})();
