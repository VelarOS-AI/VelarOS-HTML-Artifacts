export declare const DEFAULT_HTML_ARTIFACT_HEIGHT = 360;
export declare const HTML_ARTIFACT_PROTOCOL_VERSION = "1";
export type HtmlArtifactProtocolMode = 'markdown' | 'artifact' | 'action';
export type HtmlArtifactPatchType = 'replace' | 'append' | 'style' | 'script';
export type HtmlArtifactActionType = HtmlArtifactPatchType;
export type HtmlArtifactProtocolDiagnosticCode = 'invalid-base64';
export type HtmlArtifactRenderPatch = {
    type: 'replace';
    target?: string;
    html: string;
} | {
    type: 'append';
    target?: string;
    html: string;
} | {
    type: 'style';
    styleId: string;
    css: string;
} | {
    type: 'script';
    scriptId: string;
    code: string;
};
export interface HtmlArtifactDescriptor {
    id: string;
    protocolVersion?: string;
    title: string;
    initialHeight?: number;
}
export interface HtmlArtifactSnapshot extends HtmlArtifactDescriptor {
    html: string;
    protocolText?: string;
}
export interface HtmlArtifactActionState {
    type: HtmlArtifactActionType;
    target?: string;
    styleId?: string;
    scriptId?: string;
    encoding?: 'base64';
    baseHtml: string;
    html: string;
    emittedLength: number;
    emittedDiagnostics: string[];
}
export interface HtmlArtifactProtocolDiagnostic {
    code: HtmlArtifactProtocolDiagnosticCode;
    message: string;
    phase: 'protocol';
    patchType?: HtmlArtifactPatchType;
    patchId?: string;
}
export interface HtmlArtifactProtocolLimits {
    maxActionPayloadLength?: number;
    maxArtifactHtmlLength?: number;
    maxArtifactProtocolTextLength?: number;
    maxBufferLength?: number;
}
export interface HtmlArtifactProtocolStreamState {
    enabled: boolean;
    mode: HtmlArtifactProtocolMode;
    buffer: string;
    activeArtifact: HtmlArtifactDescriptor | null;
    activeAction: HtmlArtifactActionState | null;
    artifactsById: Record<string, HtmlArtifactSnapshot>;
    anonymousArtifactCounter: number;
    limits: Required<HtmlArtifactProtocolLimits>;
}
export interface HtmlArtifactProtocolStreamOptions {
    enabled?: boolean;
    initialArtifacts?: HtmlArtifactSnapshot[];
    limits?: HtmlArtifactProtocolLimits;
}
export interface HtmlArtifactProtocolStateSnapshot {
    readonly enabled: boolean;
    readonly mode: HtmlArtifactProtocolMode;
    readonly buffer: string;
    readonly activeArtifact: Readonly<HtmlArtifactDescriptor> | null;
    readonly activeAction: (Readonly<Omit<HtmlArtifactActionState, 'emittedDiagnostics'>> & {
        readonly emittedDiagnostics: readonly string[];
    }) | null;
    readonly artifactsById: Readonly<Record<string, Readonly<HtmlArtifactSnapshot>>>;
    readonly anonymousArtifactCounter: number;
    readonly limits: Readonly<Required<HtmlArtifactProtocolLimits>>;
}
/**
 * Stateful incremental parser for the HTML Artifact protocol.
 *
 * The class is the preferred API for long-lived streams. The standalone functions below remain
 * available for consumers that intentionally manage and persist the protocol state themselves.
 */
export declare class HtmlArtifactProtocolParser {
    private readonly options;
    private currentState;
    constructor(options?: HtmlArtifactProtocolStreamOptions);
    get state(): HtmlArtifactProtocolStateSnapshot;
    write(chunk: string): HtmlArtifactProtocolEvent[];
    finish(): HtmlArtifactProtocolEvent[];
    getSnapshot(artifactId: string): HtmlArtifactSnapshot | null;
    reset(): void;
}
export type HtmlArtifactProtocolEvent = {
    type: 'markdown';
    text: string;
} | {
    type: 'artifact-open';
    artifact: HtmlArtifactDescriptor;
    protocolText: string;
} | {
    type: 'artifact-update';
    artifact: HtmlArtifactDescriptor;
    html: string;
    isStreaming: boolean;
    protocolText: string;
} | {
    type: 'artifact-patch';
    artifact: HtmlArtifactDescriptor;
    patch: HtmlArtifactRenderPatch;
    protocolText: string;
} | {
    type: 'artifact-diagnostic';
    artifact: HtmlArtifactDescriptor;
    diagnostic: HtmlArtifactProtocolDiagnostic;
    protocolText: string;
} | {
    type: 'artifact-close';
    artifact: HtmlArtifactDescriptor;
    protocolText: string;
};
export declare function createHtmlArtifactProtocolStreamState(options?: HtmlArtifactProtocolStreamOptions): HtmlArtifactProtocolStreamState;
export declare function applyHtmlArtifactProtocolChunk(state: HtmlArtifactProtocolStreamState, chunk: string): HtmlArtifactProtocolEvent[];
export declare function finalizeHtmlArtifactProtocol(state: HtmlArtifactProtocolStreamState): HtmlArtifactProtocolEvent[];
//# sourceMappingURL=protocol.d.ts.map