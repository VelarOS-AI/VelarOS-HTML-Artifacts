import { applyHtmlArtifactProtocolChunk, createHtmlArtifactProtocolStreamState, DEFAULT_HTML_ARTIFACT_HEIGHT, finalizeHtmlArtifactProtocol, } from './protocol.js';
import { normalizeHtmlArtifactExternalUrl } from './security.js';
import { buildHtmlArtifactShellDocument, DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT, HTML_ARTIFACT_WHEEL_MESSAGE_TYPE, } from './shell.js';
let nextBridgeId = 0;
function createBridgeId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
        return cryptoApi.randomUUID();
    }
    nextBridgeId += 1;
    return `${Date.now().toString(36)}-${nextBridgeId.toString(36)}`;
}
function createBridgeMessages() {
    const prefix = `velaros:html-artifact:${createBridgeId()}`;
    return {
        render: `${prefix}:render`,
        patch: `${prefix}:patch`,
        resize: `${prefix}:resize`,
        sendPrompt: `${prefix}:prompt`,
        openLink: `${prefix}:link`,
        generic: `${prefix}:message`,
        error: `${prefix}:error`,
    };
}
function normalizeDimension(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.ceil(value))
        : fallback;
}
function readMessagePayload(value) {
    if (!value || typeof value !== 'object')
        return null;
    const type = value.type;
    return typeof type === 'string' ? value : null;
}
function readString(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Mount one streaming HTML artifact surface into a DOM element.
 *
 * The controller owns protocol parsing, iframe creation, sandbox transport, height negotiation,
 * action validation, and cleanup. Callers only feed model text and handle explicit capabilities.
 */
export function mountHtmlArtifact(target, options = {}) {
    if (!target || typeof target.replaceChildren !== 'function') {
        throw new TypeError('mountHtmlArtifact target must be an HTMLElement');
    }
    const minHeight = normalizeDimension(options.minHeight, 1);
    const maxHeight = Math.max(minHeight, normalizeDimension(options.maxHeight, DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT));
    const initialHeight = Math.min(maxHeight, Math.max(minHeight, normalizeDimension(options.initialHeight, DEFAULT_HTML_ARTIFACT_HEIGHT)));
    let bridgeMessages = createBridgeMessages();
    const iframe = document.createElement('iframe');
    let shellDocument = createShellDocument(bridgeMessages);
    let state = createHtmlArtifactProtocolStreamState({
        enabled: true,
        limits: options.protocolLimits,
    });
    let latestArtifactId = null;
    let disposed = false;
    let consuming = false;
    let frameReady = false;
    let settleReady = () => undefined;
    const pendingMessages = [];
    const ready = new Promise((resolve) => {
        settleReady = resolve;
    });
    function createShellDocument(messages) {
        return buildHtmlArtifactShellDocument({
            bridgeMessages: messages,
            designCss: options.designCss,
            maxReportedHeight: maxHeight,
            rootId: options.rootId,
        });
    }
    function reportError(error) {
        try {
            options.onError?.(error);
        }
        catch {
            // Error callbacks are an application boundary and must not destabilize the stream runtime.
        }
    }
    function invoke(callback, callbackName, ...args) {
        if (!callback)
            return;
        try {
            callback(...args);
        }
        catch (cause) {
            reportError({
                phase: 'host',
                message: `${callbackName} callback failed`,
                cause,
            });
        }
    }
    function assertActive() {
        if (disposed)
            throw new Error('HTML artifact controller has been disposed');
    }
    function post(payload) {
        if (!frameReady) {
            pendingMessages.push(payload);
            return;
        }
        const frameWindow = iframe.contentWindow;
        if (!frameWindow) {
            reportError({ phase: 'host', message: 'HTML artifact iframe is not available' });
            return;
        }
        frameWindow.postMessage(payload, '*');
    }
    function dispatch(events) {
        for (const event of events) {
            if (event.type === 'markdown') {
                invoke(options.onMarkdown, 'onMarkdown', event.text);
            }
            else if (event.type === 'artifact-open') {
                latestArtifactId = event.artifact.id;
            }
            else if (event.type === 'artifact-update') {
                latestArtifactId = event.artifact.id;
                post({ type: bridgeMessages.render, html: event.html, patches: [] });
            }
            else if (event.type === 'artifact-patch') {
                latestArtifactId = event.artifact.id;
                post({ type: bridgeMessages.patch, patches: [event.patch] });
            }
            else if (event.type === 'artifact-diagnostic') {
                reportError({
                    phase: 'protocol',
                    message: event.diagnostic.message,
                    patchId: event.diagnostic.patchId,
                    patchType: event.diagnostic.patchType,
                });
            }
            else if (event.type === 'artifact-close') {
                latestArtifactId = event.artifact.id;
            }
            invoke(options.onEvent, 'onEvent', event);
        }
        return events;
    }
    function getSnapshot(artifactId = latestArtifactId ?? '') {
        const snapshot = state.artifactsById[artifactId];
        return snapshot ? { ...snapshot } : null;
    }
    function applyReportedHeight(payload) {
        const candidate = Number(payload.naturalHeight ?? payload.height);
        if (!Number.isFinite(candidate) || candidate <= 0)
            return;
        const height = Math.min(maxHeight, Math.max(minHeight, Math.ceil(candidate)));
        if (Math.round(iframe.getBoundingClientRect().height) !== height) {
            iframe.style.height = `${height}px`;
        }
    }
    function handleMessage(event) {
        if (disposed)
            return;
        const payload = readMessagePayload(event.data);
        if (!payload)
            return;
        const frameWindow = iframe.contentWindow;
        if (!frameWindow || event.source !== frameWindow)
            return;
        if (payload.type === bridgeMessages.resize) {
            applyReportedHeight(payload);
        }
        else if (payload.type === bridgeMessages.sendPrompt) {
            invoke(options.onPrompt, 'onPrompt', readString(payload.prompt));
        }
        else if (payload.type === bridgeMessages.openLink) {
            const url = normalizeHtmlArtifactExternalUrl(payload.url, {
                allowedProtocols: options.allowedLinkProtocols,
            });
            if (url) {
                invoke(options.onLink, 'onLink', url);
            }
            else {
                reportError({ phase: 'security', message: 'Blocked an invalid artifact URL' });
            }
        }
        else if (payload.type === bridgeMessages.generic) {
            invoke(options.onMessage, 'onMessage', payload.payload);
        }
        else if (payload.type === bridgeMessages.error) {
            reportError({
                phase: 'runtime',
                message: readString(payload.message) || 'Artifact runtime error',
                patchId: readString(payload.patchId) || undefined,
                patchType: readString(payload.patchType) || undefined,
            });
        }
        else if (payload.type === HTML_ARTIFACT_WHEEL_MESSAGE_TYPE) {
            const deltaX = Number(payload.deltaX) || 0;
            const deltaY = Number(payload.deltaY) || 0;
            if (options.onWheel) {
                invoke(options.onWheel, 'onWheel', deltaX, deltaY);
            }
            else {
                window.scrollBy({ left: deltaX, top: deltaY });
            }
        }
    }
    function handleLoad() {
        if (disposed)
            return;
        frameReady = true;
        const frameWindow = iframe.contentWindow;
        if (frameWindow) {
            for (const payload of pendingMessages.splice(0)) {
                frameWindow.postMessage(payload, '*');
            }
        }
        settleReady(iframe);
    }
    iframe.title = options.title ?? 'HTML artifact preview';
    if (options.className)
        iframe.className = options.className;
    iframe.setAttribute('sandbox', options.sandbox ?? 'allow-scripts');
    iframe.referrerPolicy = 'no-referrer';
    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.height = `${initialHeight}px`;
    iframe.style.border = '0';
    iframe.addEventListener('load', handleLoad, { once: true });
    iframe.srcdoc = shellDocument;
    window.addEventListener('message', handleMessage);
    target.replaceChildren(iframe);
    function write(chunk) {
        assertActive();
        return dispatch(applyHtmlArtifactProtocolChunk(state, chunk));
    }
    function finish() {
        assertActive();
        return dispatch(finalizeHtmlArtifactProtocol(state));
    }
    return {
        iframe,
        ready,
        write,
        finish,
        async consume(chunks) {
            assertActive();
            if (consuming)
                throw new Error('HTML artifact controller is already consuming a stream');
            consuming = true;
            try {
                for await (const chunk of chunks) {
                    write(chunk);
                }
                finish();
                return getSnapshot();
            }
            finally {
                consuming = false;
            }
        },
        getSnapshot,
        reset() {
            assertActive();
            state = createHtmlArtifactProtocolStreamState({
                enabled: true,
                limits: options.protocolLimits,
            });
            latestArtifactId = null;
            pendingMessages.length = 0;
            frameReady = false;
            bridgeMessages = createBridgeMessages();
            shellDocument = createShellDocument(bridgeMessages);
            iframe.style.height = `${initialHeight}px`;
            iframe.addEventListener('load', handleLoad, { once: true });
            // Reloading the same shell keeps the iframe element stable while removing prior document
            // scripts, styles, timers, observers, and event listeners before the next artifact stream.
            iframe.srcdoc = shellDocument;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            consuming = false;
            pendingMessages.length = 0;
            iframe.removeEventListener('load', handleLoad);
            window.removeEventListener('message', handleMessage);
            iframe.remove();
            settleReady(iframe);
        },
    };
}
//# sourceMappingURL=browser.js.map