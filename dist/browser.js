import { DEFAULT_HTML_ARTIFACT_HEIGHT, HtmlArtifactProtocolParser, } from './protocol.js';
import { normalizeHtmlArtifactExternalUrl } from './security.js';
import { buildHtmlArtifactShellDocument, DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT, HTML_ARTIFACT_WHEEL_MESSAGE_TYPE, } from './shell.js';
/**
 * Default DOM implementation used by {@link HtmlArtifactRuntime}.
 *
 * Keeping browser access behind this object makes runtime ownership explicit and lets other
 * applications adapt the library to webviews or test environments.
 */
export class DomHtmlArtifactEnvironment {
    browserWindow;
    browserDocument;
    fallbackId = 0;
    constructor(browserWindow = window, browserDocument = document) {
        this.browserWindow = browserWindow;
        this.browserDocument = browserDocument;
    }
    createBridgeId() {
        const cryptoApi = globalThis.crypto;
        if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
            return cryptoApi.randomUUID();
        }
        this.fallbackId += 1;
        return `${Date.now().toString(36)}-${this.fallbackId.toString(36)}`;
    }
    createIframe() {
        return this.browserDocument.createElement('iframe');
    }
    addMessageListener(listener) {
        this.browserWindow.addEventListener('message', listener);
    }
    removeMessageListener(listener) {
        this.browserWindow.removeEventListener('message', listener);
    }
    scrollBy(deltaX, deltaY) {
        this.browserWindow.scrollBy({ left: deltaX, top: deltaY });
    }
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
 * Owns one artifact parser, iframe transport, host callbacks, and their complete lifecycle.
 */
export class HtmlArtifactRuntime {
    options;
    iframe;
    ready;
    environment;
    minHeight;
    maxHeight;
    initialHeight;
    parser;
    bridgeMessages;
    latestArtifactId = null;
    disposed = false;
    consuming = false;
    frameReady = false;
    settleReady = () => undefined;
    pendingMessages = [];
    constructor(target, options = {}) {
        this.options = options;
        if (!target || typeof target.replaceChildren !== 'function') {
            throw new TypeError('HtmlArtifactRuntime target must be an HTMLElement');
        }
        this.environment = options.environment ?? new DomHtmlArtifactEnvironment();
        this.minHeight = normalizeDimension(options.minHeight, 1);
        this.maxHeight = Math.max(this.minHeight, normalizeDimension(options.maxHeight, DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT));
        this.initialHeight = Math.min(this.maxHeight, Math.max(this.minHeight, normalizeDimension(options.initialHeight, DEFAULT_HTML_ARTIFACT_HEIGHT)));
        this.parser = new HtmlArtifactProtocolParser({
            enabled: true,
            limits: options.protocolLimits,
        });
        this.bridgeMessages = this.createBridgeMessages();
        this.iframe = this.environment.createIframe();
        this.ready = new Promise((resolve) => {
            this.settleReady = resolve;
        });
        this.configureIframe();
        this.environment.addMessageListener(this.handleMessage);
        target.replaceChildren(this.iframe);
    }
    write = (chunk) => {
        this.assertActive();
        return this.dispatch(this.parser.write(chunk));
    };
    finish = () => {
        this.assertActive();
        return this.dispatch(this.parser.finish());
    };
    consume = async (chunks) => {
        this.assertActive();
        if (this.consuming)
            throw new Error('HTML artifact runtime is already consuming a stream');
        this.consuming = true;
        try {
            for await (const chunk of chunks) {
                this.write(chunk);
            }
            this.finish();
            return this.getSnapshot();
        }
        finally {
            this.consuming = false;
        }
    };
    getSnapshot = (artifactId = this.latestArtifactId ?? '') => {
        return this.parser.getSnapshot(artifactId);
    };
    reset = () => {
        this.assertActive();
        this.parser.reset();
        this.latestArtifactId = null;
        this.pendingMessages.length = 0;
        this.frameReady = false;
        this.bridgeMessages = this.createBridgeMessages();
        this.iframe.style.height = `${this.initialHeight}px`;
        this.iframe.addEventListener('load', this.handleLoad, { once: true });
        // Assigning a new shell removes scripts, styles, timers, observers, and listeners while
        // retaining the iframe identity expected by the host application.
        this.iframe.srcdoc = this.createShellDocument();
    };
    dispose = () => {
        if (this.disposed)
            return;
        this.disposed = true;
        this.consuming = false;
        this.pendingMessages.length = 0;
        this.iframe.removeEventListener('load', this.handleLoad);
        this.environment.removeMessageListener(this.handleMessage);
        this.iframe.remove();
        this.settleReady(this.iframe);
    };
    configureIframe() {
        this.iframe.title = this.options.title ?? 'HTML artifact preview';
        if (this.options.className)
            this.iframe.className = this.options.className;
        this.iframe.setAttribute('sandbox', this.options.sandbox ?? 'allow-scripts');
        this.iframe.referrerPolicy = 'no-referrer';
        this.iframe.style.display = 'block';
        this.iframe.style.width = '100%';
        this.iframe.style.height = `${this.initialHeight}px`;
        this.iframe.style.border = '0';
        this.iframe.addEventListener('load', this.handleLoad, { once: true });
        this.iframe.srcdoc = this.createShellDocument();
    }
    createBridgeMessages() {
        const prefix = `velaros:html-artifact:${this.environment.createBridgeId()}`;
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
    createShellDocument() {
        return buildHtmlArtifactShellDocument({
            bridgeMessages: this.bridgeMessages,
            designCss: this.options.designCss,
            maxReportedHeight: this.maxHeight,
            rootId: this.options.rootId,
        });
    }
    reportError(error) {
        try {
            this.options.onError?.(error);
        }
        catch {
            // Error callbacks are an application boundary and must not destabilize the stream runtime.
        }
    }
    invoke(callback, callbackName, ...args) {
        if (!callback)
            return;
        try {
            callback(...args);
        }
        catch (cause) {
            this.reportError({
                phase: 'host',
                message: `${callbackName} callback failed`,
                cause,
            });
        }
    }
    assertActive() {
        if (this.disposed)
            throw new Error('HTML artifact runtime has been disposed');
    }
    post(payload) {
        if (!this.frameReady) {
            this.pendingMessages.push(payload);
            return;
        }
        const frameWindow = this.iframe.contentWindow;
        if (!frameWindow) {
            this.reportError({ phase: 'host', message: 'HTML artifact iframe is not available' });
            return;
        }
        frameWindow.postMessage(payload, '*');
    }
    dispatch(events) {
        for (const event of events) {
            switch (event.type) {
                case 'markdown':
                    this.invoke(this.options.onMarkdown, 'onMarkdown', event.text);
                    break;
                case 'artifact-open':
                    this.latestArtifactId = event.artifact.id;
                    break;
                case 'artifact-update':
                    this.latestArtifactId = event.artifact.id;
                    this.post({ type: this.bridgeMessages.render, html: event.html, patches: [] });
                    break;
                case 'artifact-patch':
                    this.latestArtifactId = event.artifact.id;
                    this.post({ type: this.bridgeMessages.patch, patches: [event.patch] });
                    break;
                case 'artifact-diagnostic':
                    this.reportError({
                        phase: 'protocol',
                        message: event.diagnostic.message,
                        patchId: event.diagnostic.patchId,
                        patchType: event.diagnostic.patchType,
                    });
                    break;
                case 'artifact-close':
                    this.latestArtifactId = event.artifact.id;
                    break;
            }
            this.invoke(this.options.onEvent, 'onEvent', event);
        }
        return events;
    }
    applyReportedHeight(payload) {
        const candidate = Number(payload.naturalHeight ?? payload.height);
        if (!Number.isFinite(candidate) || candidate <= 0)
            return;
        const height = Math.min(this.maxHeight, Math.max(this.minHeight, Math.ceil(candidate)));
        if (Math.round(this.iframe.getBoundingClientRect().height) !== height) {
            this.iframe.style.height = `${height}px`;
        }
    }
    handleMessage = (event) => {
        if (this.disposed)
            return;
        const payload = readMessagePayload(event.data);
        if (!payload)
            return;
        const frameWindow = this.iframe.contentWindow;
        if (!frameWindow || event.source !== frameWindow)
            return;
        switch (payload.type) {
            case this.bridgeMessages.resize:
                this.applyReportedHeight(payload);
                break;
            case this.bridgeMessages.sendPrompt:
                this.invoke(this.options.onPrompt, 'onPrompt', readString(payload.prompt));
                break;
            case this.bridgeMessages.openLink: {
                const url = normalizeHtmlArtifactExternalUrl(payload.url, {
                    allowedProtocols: this.options.allowedLinkProtocols,
                });
                if (url) {
                    this.invoke(this.options.onLink, 'onLink', url);
                }
                else {
                    this.reportError({ phase: 'security', message: 'Blocked an invalid artifact URL' });
                }
                break;
            }
            case this.bridgeMessages.generic:
                this.invoke(this.options.onMessage, 'onMessage', payload.payload);
                break;
            case this.bridgeMessages.error:
                this.reportError({
                    phase: 'runtime',
                    message: readString(payload.message) || 'Artifact runtime error',
                    patchId: readString(payload.patchId) || undefined,
                    patchType: readString(payload.patchType) || undefined,
                });
                break;
            case HTML_ARTIFACT_WHEEL_MESSAGE_TYPE: {
                const deltaX = Number(payload.deltaX) || 0;
                const deltaY = Number(payload.deltaY) || 0;
                if (this.options.onWheel) {
                    this.invoke(this.options.onWheel, 'onWheel', deltaX, deltaY);
                }
                else {
                    this.environment.scrollBy(deltaX, deltaY);
                }
                break;
            }
        }
    };
    handleLoad = () => {
        if (this.disposed)
            return;
        this.frameReady = true;
        const frameWindow = this.iframe.contentWindow;
        if (frameWindow) {
            for (const payload of this.pendingMessages.splice(0)) {
                frameWindow.postMessage(payload, '*');
            }
        }
        this.settleReady(this.iframe);
    };
}
/**
 * Compatibility factory for applications that prefer a function entry point.
 */
export function mountHtmlArtifact(target, options = {}) {
    return new HtmlArtifactRuntime(target, options);
}
//# sourceMappingURL=browser.js.map