/* Phone GPS + Google Directions, drawn as one e-ink frame and sent
   through the existing image upload path. */
(() => {
    const KEY_STORAGE = 'epd-google-maps-key';
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

    let mapsPromise = null;
    let watchId = null;
    let starting = false;
    let fixChain = Promise.resolve();
    let steps = [];
    let stepIndex = 0;
    let destinationText = '';
    let travelMode = 'DRIVING';
    let lastUploadKey = '';
    let sending = false;
    let rerouteAt = 0;
    let offRouteFixes = 0;
    let displayedCue = null;

    function $(id) {
        return document.getElementById(id);
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

    function stripHtml(html) {
        const node = document.createElement('div');
        node.innerHTML = html || '';
        return (node.textContent || '').replace(/\s+/g, ' ').trim();
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

    function drawArrow(ctx, maneuver, cx, cy, size) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = '#000';
        ctx.strokeStyle = '#000';
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

    function renderCue(cue) {
        const { w, h } = panelSize();
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.015));
        ctx.strokeRect(1, 1, w - 2, h - 2);

        const compact = h <= 140;
        const arrowBox = Math.min(h - 16, Math.round(w * (compact ? 0.32 : 0.28)));
        drawArrow(ctx, cue.maneuver, 8 + arrowBox / 2, h / 2, arrowBox * 0.82);

        const textX = arrowBox + 16;
        const textW = w - textX - 10;
        const distanceSize = compact ? Math.max(18, Math.round(h * 0.24)) : Math.round(h * 0.22);
        const instructionSize = compact ? Math.max(12, Math.round(h * 0.13)) : Math.round(h * 0.075);
        const footerSize = compact ? 11 : Math.round(h * 0.055);
        ctx.fillStyle = '#000';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = `bold ${distanceSize}px sans-serif`;
        ctx.fillText(cue.distanceText || '', textX, 8, textW);

        ctx.font = `bold ${instructionSize}px sans-serif`;
        const footerTop = h - footerSize - 8;
        const instructionTop = 12 + distanceSize;
        const lineHeight = instructionSize + 3;
        const maxLines = Math.max(1, Math.min(compact ? 3 : 4,
            Math.floor((footerTop - instructionTop - 4) / lineHeight)));
        const lines = wrapLines(ctx, cue.instruction || '', textW, maxLines);
        lines.forEach((line, index) => {
            ctx.fillText(line, textX, instructionTop + index * lineHeight);
        });

        ctx.font = `${footerSize}px sans-serif`;
        ctx.fillText(cue.footer || '', textX, h - footerSize - 8, textW);
        return canvas;
    }

    function showCanvas(canvas) {
        const preview = $('nav-preview');
        if (!preview) return;
        preview.width = canvas.width;
        preview.height = canvas.height;
        preview.getContext('2d').drawImage(canvas, 0, 0);
    }

    function showCue(cue) {
        displayedCue = cue;
        showCanvas(renderCue(cue));
    }

    function sampleCue() {
        return {
            maneuver: 'turn-left',
            instruction: 'Rẽ trái vào đường Nguyễn Huệ',
            distanceText: '120 m',
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

    function uploadKey(index, remainMeters) {
        const distanceUpdates = $('nav-distance-updates')?.checked;
        return distanceUpdates ? `${index}:${distanceBucket(remainMeters)}` : String(index);
    }

    async function sendCurrentPreview() {
        if (!displayedCue) showCue(sampleCue());
        const canvas = renderCue(displayedCue);
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
            setStatus('Đang gửi mặt chỉ đường lên e-ink...');
            await upload_image();
            setStatus('Đã gửi mặt chỉ đường.');
            if (typeof addLog === 'function') addLog('Chỉ đường: đã gửi một mặt lên e-ink.');
        } finally {
            sending = false;
            clockImageUploadBusy = false;
            if (typeof updateClockImageAvailability === 'function') updateClockImageAvailability();
        }
    }

    function loadMaps(key) {
        if (window.google?.maps?.DirectionsService) return Promise.resolve();
        if (mapsPromise) return mapsPromise;
        mapsPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                mapsPromise = null;
                reject(new Error('Không tải được Google Maps. Kiểm tra mạng và khóa API.'));
            }, 15000);
            window.gm_authFailure = () => {
                clearTimeout(timer);
                mapsPromise = null;
                reject(new Error('Google từ chối khóa. Hãy bật Maps JavaScript API, Directions API và cho phép địa chỉ trang này.'));
            };
            window.__einkNavMapsReady = () => {
                clearTimeout(timer);
                resolve();
            };
            const script = document.createElement('script');
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=vi&region=VN&callback=__einkNavMapsReady`;
            script.async = true;
            script.onerror = () => {
                clearTimeout(timer);
                mapsPromise = null;
                reject(new Error('Không tải được Google Maps.'));
            };
            document.head.appendChild(script);
        });
        return mapsPromise;
    }

    function requestRoute(origin) {
        const service = new google.maps.DirectionsService();
        return new Promise((resolve, reject) => {
            service.route({
                origin,
                destination: destinationText,
                travelMode: google.maps.TravelMode[travelMode] || 'DRIVING',
                region: 'vn',
                language: 'vi',
                provideRouteAlternatives: false
            }, (result, status) => {
                if (status === 'OK' && result.routes && result.routes[0]) resolve(result.routes[0]);
                else reject(new Error(`Google Directions: ${status}`));
            });
        });
    }

    function adoptRoute(route) {
        const nextSteps = [];
        (route.legs || []).forEach(leg => {
            (leg.steps || []).forEach(step => {
                const path = (step.path || step.lat_lngs || []).map(pointOf).filter(Boolean);
                nextSteps.push({
                    instruction: stripHtml(step.instructions || step.html_instructions || 'Đi tiếp'),
                    maneuver: step.maneuver || '',
                    distance: step.distance?.value || 0,
                    duration: step.duration?.value || 0,
                    path,
                    start: pointOf(step.start_location),
                    end: pointOf(step.end_location)
                });
            });
        });
        if (!nextSteps.length) throw new Error('Lộ trình không có bước chỉ dẫn.');
        steps = nextSteps;
        stepIndex = 0;
        lastUploadKey = '';
        offRouteFixes = 0;
        renderStepList(0);
    }

    async function publishFix(here, forceUpload) {
        const place = locate(here);
        const limit = travelMode === 'WALKING' ? 45 : 70;
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
        showCue(cue);
        renderStepList(stepIndex);
        const key = uploadKey(stepIndex, active.remain);
        const changed = forceUpload || key !== lastUploadKey;
        const einkReady = typeof gattServer !== 'undefined' && gattServer?.connected;
        if (sending || !changed) {
            setStatus(`${cue.distanceText} · ${cue.instruction}`);
            return;
        }
        if (!einkReady) {
            setStatus('Đã có chỉ dẫn. Kết nối e-ink rồi bấm “Gửi mặt đang xem lên e-ink”.');
            return;
        }
        try {
            await sendCurrentPreview();
            lastUploadKey = key;
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
        const key = ($('nav-api-key')?.value || '').trim();
        destinationText = ($('nav-destination')?.value || '').trim();
        travelMode = $('nav-mode')?.value || 'DRIVING';
        if (!key) {
            setStatus('Hãy dán khóa Google Maps trước.', true);
            return;
        }
        if (!destinationText) {
            setStatus('Hãy nhập điểm đến.', true);
            return;
        }
        if (!navigator.geolocation) {
            setStatus('Trình duyệt này không cung cấp vị trí.', true);
            return;
        }
        try {
            localStorage.setItem(KEY_STORAGE, key);
        } catch (storageError) {
            // Private browsing can reject storage; the field still holds the key.
        }
        setStatus('Đang tải Google Maps...');
        await loadMaps(key);
        const origin = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
                position => resolve({
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                }),
                error => reject(new Error(error.message || 'Không lấy được vị trí.')),
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
            );
        });
        setStatus('Đang tính lộ trình...');
        adoptRoute(await requestRoute(origin));
        await publishFix(origin, true);
        watchId = navigator.geolocation.watchPosition(position => {
            const here = { lat: position.coords.latitude, lng: position.coords.longitude };
            fixChain = fixChain.then(() => publishFix(here, false)).catch(error => {
                setStatus(error.message || String(error), true);
            });
        }, error => {
            setStatus(error.message || 'Mất tín hiệu vị trí.', true);
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 });
    }

    function stopNavigation() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        setStatus('Đã dừng theo dõi. Màn e-ink giữ mặt chỉ đường cuối.');
    }

    window.refreshNavPreview = function () {
        showCue(displayedCue || sampleCue());
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
        showCue(sampleCue());
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
        $('screen-size')?.addEventListener('change', () => window.refreshNavPreview());
    });
})();
