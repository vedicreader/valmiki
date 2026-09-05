const htmlElement = document.documentElement;
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const KEY = 'valmiki';
let S = JSON.parse(localStorage.getItem(KEY) || '{{__state__}}');
function storeState(key, value) {S[key] = value; localStorage.setItem(KEY, JSON.stringify(S));}
function getState(key){return S[key];}
let uiReady = false, uiTimer = null;   // uiReady: skip the fade on initial paint
function withUiAnim(apply) {
    if (!uiReady || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {apply(); return;}
    htmlElement.classList.add('ui-anim');
    apply();
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => htmlElement.classList.remove('ui-anim'), 220);
}
function setCls(key, value, fn=null, ...args) {
    if (value === null || value === undefined) {return;}
    withUiAnim(() => {
        if (S[key]) htmlElement.classList.remove(S[key]);
        htmlElement.classList.add(value);
        storeState(key, value);
    });
    if (typeof fn === 'function') {fn(...args);}
}
function setTheme(color, fn=null, ...args) {setCls('theme', color, fn, ...args);}
function setRadii(radii, fn=null, ...args) {setCls('radii', radii, fn, ...args);}
function setShadows(shadows, fn=null, ...args) {setCls('shadows', shadows, fn, ...args);}
function setFont(font, fn=null, ...args) {setCls('font', font, fn, ...args);}
function applyMode(mode) {
    if (mode === 'dark') {htmlElement.classList.remove('light', 'auto'); htmlElement.classList.add('dark'); storeState('mode', mode);}
    if (mode === 'light') {htmlElement.classList.remove('dark', 'auto'); htmlElement.classList.add('light'); storeState('mode', mode);}
    if (mode === 'auto') {
        const isDark = mediaQuery.matches;
        htmlElement.classList.remove(isDark ? 'light' : 'dark');
        htmlElement.classList.add(isDark ? 'dark' : 'light', 'auto');
        storeState('mode', mode);
    }
}
function setMode(mode, fn=null, ...args) {
    if (mode === null || mode === undefined) {return;}
    withUiAnim(() => applyMode(mode));
    if (typeof fn === 'function') {fn(...args);}
}
function setup() {
    setTheme('{{__theme__}}');
    setMode(S.mode);
    setRadii(S.radii);
    setShadows(S.shadows);
    setFont(S.font);
    uiReady = true;}

mediaQuery.addEventListener('change', (event) => {if (!htmlElement.classList.contains('auto')) return; setMode('auto');});
setTimeout(setup, 50);
