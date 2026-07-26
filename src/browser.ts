import {
  DEFAULT_HTML_ARTIFACT_HEIGHT,
  HtmlArtifactProtocolParser,
  type HtmlArtifactProtocolEvent,
  type HtmlArtifactProtocolLimits,
  type HtmlArtifactSnapshot,
} from './protocol.js'
import { normalizeHtmlArtifactExternalUrl } from './security.js'
import {
  buildHtmlArtifactShellDocument,
  DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT,
  HTML_ARTIFACT_WHEEL_MESSAGE_TYPE,
  type HtmlArtifactBridgeMessages,
} from './shell.js'

export type HtmlArtifactHostErrorPhase = 'host' | 'protocol' | 'runtime' | 'security'

export interface HtmlArtifactHostError {
  message: string
  phase: HtmlArtifactHostErrorPhase
  cause?: unknown
  patchId?: string
  patchType?: string
}

/**
 * Browser operations used by the artifact runtime.
 *
 * Applications can provide an implementation for alternate DOM hosts, tests, or embedded
 * webviews without patching browser globals.
 */
export interface HtmlArtifactBrowserEnvironment {
  createBridgeId(): string
  createIframe(): HTMLIFrameElement
  addMessageListener(listener: (event: MessageEvent<unknown>) => void): void
  removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void
  scrollBy(deltaX: number, deltaY: number): void
}

export interface MountHtmlArtifactOptions {
  /** Accessible title applied to the generated iframe. */
  title?: string
  /** Optional class name applied to the generated iframe. */
  className?: string
  /** iframe sandbox tokens. Defaults to the deliberately small `allow-scripts`. */
  sandbox?: string
  /** Height used before the runtime publishes its first measurement. */
  initialHeight?: number
  /** Smallest height the host will apply after a runtime measurement. */
  minHeight?: number
  /** Hard height cap. Taller content scrolls inside the iframe. */
  maxHeight?: number
  /** Product-neutral CSS injected before generated artifact styles. */
  designCss?: string
  /** Root element id inside the iframe shell. */
  rootId?: string
  /** Protocol resource limits for hostile or unexpectedly large streams. */
  protocolLimits?: HtmlArtifactProtocolLimits
  /** URL protocols handed to `onLink`. Defaults to HTTP and HTTPS. */
  allowedLinkProtocols?: readonly string[]
  /** Browser boundary used to create the iframe and subscribe to messages. */
  environment?: HtmlArtifactBrowserEnvironment
  onMarkdown?: (text: string) => void
  onPrompt?: (prompt: string) => void
  onLink?: (url: string) => void
  onMessage?: (payload: unknown) => void
  onWheel?: (deltaX: number, deltaY: number) => void
  onEvent?: (event: HtmlArtifactProtocolEvent) => void
  onError?: (error: HtmlArtifactHostError) => void
}

export interface HtmlArtifactController {
  readonly iframe: HTMLIFrameElement
  /** Resolves after the sandbox shell has loaded and queued render events have been delivered. */
  readonly ready: Promise<HTMLIFrameElement>
  write(chunk: string): HtmlArtifactProtocolEvent[]
  finish(): HtmlArtifactProtocolEvent[]
  consume(chunks: AsyncIterable<string> | Iterable<string>): Promise<HtmlArtifactSnapshot | null>
  getSnapshot(artifactId?: string): HtmlArtifactSnapshot | null
  reset(): void
  dispose(): void
}

type MessagePayload = Record<string, unknown> & { type: string }

/**
 * Default DOM implementation used by {@link HtmlArtifactRuntime}.
 *
 * Keeping browser access behind this object makes runtime ownership explicit and lets other
 * applications adapt the library to webviews or test environments.
 */
export class DomHtmlArtifactEnvironment implements HtmlArtifactBrowserEnvironment {
  private fallbackId = 0

  constructor(
    private readonly browserWindow: Window = window,
    private readonly browserDocument: Document = document
  ) {}

  createBridgeId(): string {
    const cryptoApi = globalThis.crypto
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID()
    }

    this.fallbackId += 1
    return `${Date.now().toString(36)}-${this.fallbackId.toString(36)}`
  }

  createIframe(): HTMLIFrameElement {
    return this.browserDocument.createElement('iframe')
  }

  addMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.browserWindow.addEventListener('message', listener)
  }

  removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.browserWindow.removeEventListener('message', listener)
  }

  scrollBy(deltaX: number, deltaY: number): void {
    this.browserWindow.scrollBy({ left: deltaX, top: deltaY })
  }
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.ceil(value))
    : fallback
}

function readMessagePayload(value: unknown): MessagePayload | null {
  if (!value || typeof value !== 'object') return null
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' ? (value as MessagePayload) : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Owns one artifact parser, iframe transport, host callbacks, and their complete lifecycle.
 */
export class HtmlArtifactRuntime implements HtmlArtifactController {
  readonly iframe: HTMLIFrameElement
  readonly ready: Promise<HTMLIFrameElement>

  private readonly environment: HtmlArtifactBrowserEnvironment
  private readonly minHeight: number
  private readonly maxHeight: number
  private readonly initialHeight: number
  private readonly parser: HtmlArtifactProtocolParser
  private bridgeMessages: HtmlArtifactBridgeMessages
  private latestArtifactId: string | null = null
  private disposed = false
  private consuming = false
  private frameReady = false
  private settleReady: (frame: HTMLIFrameElement) => void = () => undefined
  private readonly pendingMessages: MessagePayload[] = []

  constructor(
    target: HTMLElement,
    private readonly options: MountHtmlArtifactOptions = {}
  ) {
    if (!target || typeof target.replaceChildren !== 'function') {
      throw new TypeError('HtmlArtifactRuntime target must be an HTMLElement')
    }

    this.environment = options.environment ?? new DomHtmlArtifactEnvironment()
    this.minHeight = normalizeDimension(options.minHeight, 1)
    this.maxHeight = Math.max(
      this.minHeight,
      normalizeDimension(options.maxHeight, DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT)
    )
    this.initialHeight = Math.min(
      this.maxHeight,
      Math.max(
        this.minHeight,
        normalizeDimension(options.initialHeight, DEFAULT_HTML_ARTIFACT_HEIGHT)
      )
    )
    this.parser = new HtmlArtifactProtocolParser({
      enabled: true,
      limits: options.protocolLimits,
    })
    this.bridgeMessages = this.createBridgeMessages()
    this.iframe = this.environment.createIframe()
    this.ready = new Promise<HTMLIFrameElement>((resolve) => {
      this.settleReady = resolve
    })

    this.configureIframe()
    this.environment.addMessageListener(this.handleMessage)
    target.replaceChildren(this.iframe)
  }

  readonly write = (chunk: string): HtmlArtifactProtocolEvent[] => {
    this.assertActive()
    return this.dispatch(this.parser.write(chunk))
  }

  readonly finish = (): HtmlArtifactProtocolEvent[] => {
    this.assertActive()
    return this.dispatch(this.parser.finish())
  }

  readonly consume = async (
    chunks: AsyncIterable<string> | Iterable<string>
  ): Promise<HtmlArtifactSnapshot | null> => {
    this.assertActive()
    if (this.consuming) throw new Error('HTML artifact runtime is already consuming a stream')

    this.consuming = true
    try {
      for await (const chunk of chunks) {
        this.write(chunk)
      }
      this.finish()
      return this.getSnapshot()
    } finally {
      this.consuming = false
    }
  }

  readonly getSnapshot = (
    artifactId = this.latestArtifactId ?? ''
  ): HtmlArtifactSnapshot | null => {
    return this.parser.getSnapshot(artifactId)
  }

  readonly reset = (): void => {
    this.assertActive()
    this.parser.reset()
    this.latestArtifactId = null
    this.pendingMessages.length = 0
    this.frameReady = false
    this.bridgeMessages = this.createBridgeMessages()
    this.iframe.style.height = `${this.initialHeight}px`
    this.iframe.addEventListener('load', this.handleLoad, { once: true })
    // Assigning a new shell removes scripts, styles, timers, observers, and listeners while
    // retaining the iframe identity expected by the host application.
    this.iframe.srcdoc = this.createShellDocument()
  }

  readonly dispose = (): void => {
    if (this.disposed) return

    this.disposed = true
    this.consuming = false
    this.pendingMessages.length = 0
    this.iframe.removeEventListener('load', this.handleLoad)
    this.environment.removeMessageListener(this.handleMessage)
    this.iframe.remove()
    this.settleReady(this.iframe)
  }

  private configureIframe(): void {
    this.iframe.title = this.options.title ?? 'HTML artifact preview'
    if (this.options.className) this.iframe.className = this.options.className
    this.iframe.setAttribute('sandbox', this.options.sandbox ?? 'allow-scripts')
    this.iframe.referrerPolicy = 'no-referrer'
    this.iframe.style.display = 'block'
    this.iframe.style.width = '100%'
    this.iframe.style.height = `${this.initialHeight}px`
    this.iframe.style.border = '0'
    this.iframe.addEventListener('load', this.handleLoad, { once: true })
    this.iframe.srcdoc = this.createShellDocument()
  }

  private createBridgeMessages(): HtmlArtifactBridgeMessages {
    const prefix = `velaros:html-artifact:${this.environment.createBridgeId()}`
    return {
      render: `${prefix}:render`,
      patch: `${prefix}:patch`,
      resize: `${prefix}:resize`,
      sendPrompt: `${prefix}:prompt`,
      openLink: `${prefix}:link`,
      generic: `${prefix}:message`,
      error: `${prefix}:error`,
    }
  }

  private createShellDocument(): string {
    return buildHtmlArtifactShellDocument({
      bridgeMessages: this.bridgeMessages,
      designCss: this.options.designCss,
      maxReportedHeight: this.maxHeight,
      rootId: this.options.rootId,
    })
  }

  private reportError(error: HtmlArtifactHostError): void {
    try {
      this.options.onError?.(error)
    } catch {
      // Error callbacks are an application boundary and must not destabilize the stream runtime.
    }
  }

  private invoke<T extends unknown[]>(
    callback: ((...args: T) => void) | undefined,
    callbackName: string,
    ...args: T
  ): void {
    if (!callback) return
    try {
      callback(...args)
    } catch (cause) {
      this.reportError({
        phase: 'host',
        message: `${callbackName} callback failed`,
        cause,
      })
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('HTML artifact runtime has been disposed')
  }

  private post(payload: MessagePayload): void {
    if (!this.frameReady) {
      this.pendingMessages.push(payload)
      return
    }

    const frameWindow = this.iframe.contentWindow
    if (!frameWindow) {
      this.reportError({ phase: 'host', message: 'HTML artifact iframe is not available' })
      return
    }
    frameWindow.postMessage(payload, '*')
  }

  private dispatch(events: HtmlArtifactProtocolEvent[]): HtmlArtifactProtocolEvent[] {
    for (const event of events) {
      switch (event.type) {
        case 'markdown':
          this.invoke(this.options.onMarkdown, 'onMarkdown', event.text)
          break
        case 'artifact-open':
          this.latestArtifactId = event.artifact.id
          break
        case 'artifact-update':
          this.latestArtifactId = event.artifact.id
          this.post({ type: this.bridgeMessages.render, html: event.html, patches: [] })
          break
        case 'artifact-patch':
          this.latestArtifactId = event.artifact.id
          this.post({ type: this.bridgeMessages.patch, patches: [event.patch] })
          break
        case 'artifact-diagnostic':
          this.reportError({
            phase: 'protocol',
            message: event.diagnostic.message,
            patchId: event.diagnostic.patchId,
            patchType: event.diagnostic.patchType,
          })
          break
        case 'artifact-close':
          this.latestArtifactId = event.artifact.id
          break
      }

      this.invoke(this.options.onEvent, 'onEvent', event)
    }
    return events
  }

  private applyReportedHeight(payload: MessagePayload): void {
    const candidate = Number(payload.naturalHeight ?? payload.height)
    if (!Number.isFinite(candidate) || candidate <= 0) return

    const height = Math.min(this.maxHeight, Math.max(this.minHeight, Math.ceil(candidate)))
    if (Math.round(this.iframe.getBoundingClientRect().height) !== height) {
      this.iframe.style.height = `${height}px`
    }
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (this.disposed) return
    const payload = readMessagePayload(event.data)
    if (!payload) return

    const frameWindow = this.iframe.contentWindow
    if (!frameWindow || event.source !== frameWindow) return

    switch (payload.type) {
      case this.bridgeMessages.resize:
        this.applyReportedHeight(payload)
        break
      case this.bridgeMessages.sendPrompt:
        this.invoke(this.options.onPrompt, 'onPrompt', readString(payload.prompt))
        break
      case this.bridgeMessages.openLink: {
        const url = normalizeHtmlArtifactExternalUrl(payload.url, {
          allowedProtocols: this.options.allowedLinkProtocols,
        })
        if (url) {
          this.invoke(this.options.onLink, 'onLink', url)
        } else {
          this.reportError({ phase: 'security', message: 'Blocked an invalid artifact URL' })
        }
        break
      }
      case this.bridgeMessages.generic:
        this.invoke(this.options.onMessage, 'onMessage', payload.payload)
        break
      case this.bridgeMessages.error:
        this.reportError({
          phase: 'runtime',
          message: readString(payload.message) || 'Artifact runtime error',
          patchId: readString(payload.patchId) || undefined,
          patchType: readString(payload.patchType) || undefined,
        })
        break
      case HTML_ARTIFACT_WHEEL_MESSAGE_TYPE: {
        const deltaX = Number(payload.deltaX) || 0
        const deltaY = Number(payload.deltaY) || 0
        if (this.options.onWheel) {
          this.invoke(this.options.onWheel, 'onWheel', deltaX, deltaY)
        } else {
          this.environment.scrollBy(deltaX, deltaY)
        }
        break
      }
    }
  }

  private readonly handleLoad = (): void => {
    if (this.disposed) return
    this.frameReady = true

    const frameWindow = this.iframe.contentWindow
    if (frameWindow) {
      for (const payload of this.pendingMessages.splice(0)) {
        frameWindow.postMessage(payload, '*')
      }
    }
    this.settleReady(this.iframe)
  }
}

/**
 * Compatibility factory for applications that prefer a function entry point.
 */
export function mountHtmlArtifact(
  target: HTMLElement,
  options: MountHtmlArtifactOptions = {}
): HtmlArtifactController {
  return new HtmlArtifactRuntime(target, options)
}
