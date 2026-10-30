// Synthetic iPhone geometry, real exported SessionView/CSS. No OS keyboard is
// emulated. Use --serve --silent-keyboard with session-header.cjs and a 440×736
// browser viewport; all mutations below are exposed as visible fixture buttons.
(() => {
    let height = 736, resizeEvents = 0, flavor = 'claude';
    Object.defineProperty(navigator, 'userAgent', {configurable: true, get: () => 'iPhone AppleWebKit Safari'});
    Object.defineProperty(window, 'innerHeight', {configurable: true, get: () => 736});
    for (const [key, get] of Object.entries({height: () => height, width: () => 440,
        scale: () => 1, pageTop: () => 0, offsetTop: () => 0})) {
        Object.defineProperty(visualViewport, key, {configurable: true, get});
    }
    visualViewport.addEventListener('resize', () => resizeEvents++);
    window.addEventListener('load', () => {
        const panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;top:65px;left:8px;right:8px;z-index:2147483647;background:#fff;color:#111;border:1px solid #555;padding:6px;font:12px system-ui';
        const output = document.createElement('pre'); output.dataset.testid = 'keyboard-probe';
        output.style.cssText = 'white-space:pre-wrap;margin:4px';
        const measure = () => {
            const field = document.querySelector('textarea[data-lmc-text-input]');
            let owner = field;
            while (owner && !owner.style.getPropertyValue('--lmc-keyboard-inset')) owner = owner.parentElement;
            output.textContent = JSON.stringify({flavor, height, resizeEvents,
                inset: owner?.style.getPropertyValue('--lmc-keyboard-inset'),
                composerBottom: document.querySelector('[data-lmc-composer]')?.getBoundingClientRect().bottom,
                fieldBottom: field?.getBoundingClientRect().bottom,
                focused: field === document.activeElement, draft: field?.value}, null, 1);
        };
        const changeHeight = (next, emit) => {
            height = next;
            if (emit) visualViewport.dispatchEvent(new Event('resize'));
            setTimeout(measure, 550);
        };
        for (const [label, action] of [
            ['合成 Claude', () => {flavor = 'claude'; setFlavor(flavor); setTimeout(measure, 100)}],
            ['合成 Codex', () => {flavor = 'codex'; setFlavor(flavor); setTimeout(measure, 100)}],
            ['键盘 419', () => {
                const field = document.querySelector('textarea[data-lmc-text-input]');
                field.dataset.lmcFocusScroll = 'controlled'; field.focus({preventScroll: true});
                changeHeight(419, true);
            }],
            ['静默变为 402', () => changeHeight(402, false)],
            ['收起键盘', () => changeHeight(736, true)],
            ['读取位置', measure]
        ]) {
            const button = document.createElement('button'); button.textContent = label;
            button.onmousedown = event => event.preventDefault();
            button.onclick = action; panel.appendChild(button);
        }
        panel.appendChild(output); document.body.appendChild(panel);
        setMeta({engineAuth:{status:'ready',checkedAt:Date.now()},sessionConfigState:'applied',sessionConfigError:null});
        measure();
    });
})();
