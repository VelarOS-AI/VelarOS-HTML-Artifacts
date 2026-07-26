import { type HtmlArtifactProtocolEvent, type HtmlArtifactProtocolLimits, type HtmlArtifactSnapshot } from './protocol.js';
export type HtmlArtifactHostErrorPhase = 'host' | 'protocol' | 'runtime' | 'security';
export interface HtmlArtifactHostError {
    message: string;
    phase: HtmlArtifactHostErrorPhase;
    cause?: unknown;
    patchId?: string;
    patchType?: string;
}
/**
 * Browser operations used by the artifact runtime.
 *
 * Applications can provide an implementation for alternate DOM hosts, tests, or embedded
 * webviews without patching browser globals.
 */
export interface HtmlArtifactBrowserEnvironment {
    createBridgeId(): string;
    createIframe(): HTMLIFrameElement;
    addMessageListener(listener: (event: MessageEvent<unknown>) => void): void;
    removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void;
    scrollBy(deltaX: number, deltaY: number): void;
}
export interface MountHtmlArtifactOptions {
    /** Accessible title applied to the generated iframe. */
    title?: string;
    /** Optional class name applied to the generated iframe. */
    className?: string;
    /** iframe sandbox tokens. Defaults to the deliberately small `allow-scripts`. */
    sandbox?: string;
    /** Height used before the runtime publishes its first measurement. */
    initialHeight?: number;
    /** Smallest height the host will apply after a runtime measurement. */
    minHeight?: number;
    /** Hard height cap. Taller content scrolls inside the iframe. */
    maxHeight?: number;
    /** Product-neutral CSS injected before generated artifact styles. */
    designCss?: string;
    /** Root element id inside the iframe shell. */
    rootId?: string;
    /** Protocol resource limits for hostile or unexpectedly large streams. */
    protocolLimits?: HtmlArtifactProtocolLimits;
    /** URL protocols handed to `onLink`. Defaults to HTTP and HTTPS. */
    allowedLinkProtocols?: readonly string[];
    /** Browser boundary used to create the iframe and subscribe to messages. */
    environment?: HtmlArtifactBrowserEnvironment;
    onMarkdown?: (text: string) => void;
    onPrompt?: (prompt: string) => void;
    onLink?: (url: string) => void;
    onMessage?: (payload: unknown) => void;
    onWheel?: (deltaX: number, deltaY: number) => void;
    onEvent?: (event: HtmlArtifactProtocolEvent) => void;
    onError?: (error: HtmlArtifactHostError) => void;
}
export interface HtmlArtifactController {
    readonly iframe: HTMLIFrameElement;
    /** Resolves after the sandbox shell has loaded and queued render events have been delivered. */
    readonly ready: Promise<HTMLIFrameElement>;
    write(chunk: string): HtmlArtifactProtocolEvent[];
    finish(): HtmlArtifactProtocolEvent[];
    consume(chunks: AsyncIterable<string> | Iterable<string>): Promise<HtmlArtifactSnapshot | null>;
    getSnapshot(artifactId?: string): HtmlArtifactSnapshot | null;
    reset(): void;
    dispose(): void;
}
/**
 * Default DOM implementation used by {@link HtmlArtifactRuntime}.
 *
 * Keeping browser access behind this object makes runtime ownership explicit and lets other
 * applications adapt the library to webviews or test environments.
 */
export declare class DomHtmlArtifactEnvironment implements HtmlArtifactBrowserEnvironment {
    private readonly browserWindow;
    private readonly browserDocument;
    private fallbackId;
    constructor(browserWindow?: Window, browserDocument?: Document);
    createBridgeId(): string;
    createIframe(): HTMLIFrameElement;
    addMessageListener(listener: (event: MessageEvent<unknown>) => void): void;
    removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void;
    scrollBy(deltaX: number, deltaY: number): void;
}
/**
 * Owns one artifact parser, iframe transport, host callbacks, and their complete lifecycle.
 */
export declare class HtmlArtifactRuntime implements HtmlArtifactController {
    private readonly options;
    readonly iframe: HTMLIFrameElement;
    readonly ready: Promise<HTMLIFrameElement>;
    private readonly environment;
    private readonly minHeight;
    private readonly maxHeight;
    private readonly initialHeight;
    private readonly parser;
    private bridgeMessages;
    private latestArtifactId;
    private disposed;
    private consuming;
    private frameReady;
    private settleReady;
    private readonly pendingMessages;
    constructor(target: HTMLElement, options?: MountHtmlArtifactOptions);
    readonly write: (chunk: string) => HtmlArtifactProtocolEvent[];
    readonly finish: () => HtmlArtifactProtocolEvent[];
    readonly consume: (chunks: AsyncIterable<string> | Iterable<string>) => Promise<HtmlArtifactSnapshot | null>;
    readonly getSnapshot: (artifactId?: string) => HtmlArtifactSnapshot | null;
    readonly reset: () => void;
    readonly dispose: () => void;
    private configureIframe;
    private createBridgeMessages;
    private createShellDocument;
    private reportError;
    private invoke;
    private assertActive;
    private post;
    private dispatch;
    private applyReportedHeight;
    private readonly handleMessage;
    private readonly handleLoad;
}
/**
 * Compatibility factory for applications that prefer a function entry point.
 */
export declare function mountHtmlArtifact(target: HTMLElement, options?: MountHtmlArtifactOptions): HtmlArtifactController;
//# sourceMappingURL=browser.d.ts.map