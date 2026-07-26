export const DEFAULT_HTML_ARTIFACT_HEIGHT = 360
export const HTML_ARTIFACT_PROTOCOL_VERSION = '1'

const ARTIFACT_OPEN = '<artifact'
const ARTIFACT_CLOSE = '</artifact>'
const PATCH_OPEN = '<patch'
const PATCH_CLOSE = '</patch>'
const PARTIAL_PROTOCOL_CANDIDATES = [ARTIFACT_OPEN, PATCH_OPEN, ARTIFACT_CLOSE, PATCH_CLOSE]
const MARKDOWN_PARTIAL_PROTOCOL_CANDIDATES = [ARTIFACT_OPEN]
const MAX_ARTIFACT_TITLE_LENGTH = 80
const MAX_ARTIFACT_ID_LENGTH = 80
const DEFAULT_MAX_BUFFER_LENGTH = 16_384
const DEFAULT_MAX_ARTIFACT_HTML_LENGTH = 256_000
const DEFAULT_MAX_ARTIFACT_PROTOCOL_TEXT_LENGTH = 256_000
const DEFAULT_MAX_ACTION_PAYLOAD_LENGTH = 256_000
const MAX_PATCH_METADATA_LENGTH = 160
const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

export type HtmlArtifactProtocolMode = 'markdown' | 'artifact' | 'action'
export type HtmlArtifactPatchType = 'replace' | 'append' | 'style' | 'script'
export type HtmlArtifactActionType = HtmlArtifactPatchType
export type HtmlArtifactProtocolDiagnosticCode = 'invalid-base64'

export type HtmlArtifactRenderPatch =
  | { type: 'replace'; target?: string; html: string }
  | { type: 'append'; target?: string; html: string }
  | { type: 'style'; styleId: string; css: string }
  | { type: 'script'; scriptId: string; code: string }

export interface HtmlArtifactDescriptor {
  id: string
  protocolVersion?: string
  title: string
  initialHeight?: number
}

export interface HtmlArtifactSnapshot extends HtmlArtifactDescriptor {
  html: string
  protocolText?: string
}

export interface HtmlArtifactActionState {
  type: HtmlArtifactActionType
  target?: string
  styleId?: string
  scriptId?: string
  encoding?: 'base64'
  baseHtml: string
  html: string
  emittedLength: number
  emittedDiagnostics: string[]
}

export interface HtmlArtifactProtocolDiagnostic {
  code: HtmlArtifactProtocolDiagnosticCode
  message: string
  phase: 'protocol'
  patchType?: HtmlArtifactPatchType
  patchId?: string
}

export interface HtmlArtifactProtocolLimits {
  maxActionPayloadLength?: number
  maxArtifactHtmlLength?: number
  maxArtifactProtocolTextLength?: number
  maxBufferLength?: number
}

export interface HtmlArtifactProtocolStreamState {
  enabled: boolean
  mode: HtmlArtifactProtocolMode
  buffer: string
  activeArtifact: HtmlArtifactDescriptor | null
  activeAction: HtmlArtifactActionState | null
  artifactsById: Record<string, HtmlArtifactSnapshot>
  anonymousArtifactCounter: number
  limits: Required<HtmlArtifactProtocolLimits>
}

export interface HtmlArtifactProtocolStreamOptions {
  enabled?: boolean
  initialArtifacts?: HtmlArtifactSnapshot[]
  limits?: HtmlArtifactProtocolLimits
}

export interface HtmlArtifactProtocolStateSnapshot {
  readonly enabled: boolean
  readonly mode: HtmlArtifactProtocolMode
  readonly buffer: string
  readonly activeArtifact: Readonly<HtmlArtifactDescriptor> | null
  readonly activeAction:
    | (Readonly<Omit<HtmlArtifactActionState, 'emittedDiagnostics'>> & {
        readonly emittedDiagnostics: readonly string[]
      })
    | null
  readonly artifactsById: Readonly<Record<string, Readonly<HtmlArtifactSnapshot>>>
  readonly anonymousArtifactCounter: number
  readonly limits: Readonly<Required<HtmlArtifactProtocolLimits>>
}

/**
 * Stateful incremental parser for the HTML Artifact protocol.
 *
 * The class is the preferred API for long-lived streams. The standalone functions below remain
 * available for consumers that intentionally manage and persist the protocol state themselves.
 */
export class HtmlArtifactProtocolParser {
  private currentState: HtmlArtifactProtocolStreamState

  constructor(private readonly options: HtmlArtifactProtocolStreamOptions = {}) {
    this.currentState = createHtmlArtifactProtocolStreamState(options)
  }

  get state(): HtmlArtifactProtocolStateSnapshot {
    const artifactsById = Object.fromEntries(
      Object.entries(this.currentState.artifactsById).map(([id, artifact]) => [
        id,
        Object.freeze({ ...artifact }),
      ])
    )
    const activeAction = this.currentState.activeAction
      ? Object.freeze({
          ...this.currentState.activeAction,
          emittedDiagnostics: Object.freeze([
            ...this.currentState.activeAction.emittedDiagnostics,
          ]),
        })
      : null
    return Object.freeze({
      ...this.currentState,
      activeArtifact: this.currentState.activeArtifact
        ? Object.freeze({ ...this.currentState.activeArtifact })
        : null,
      activeAction,
      artifactsById: Object.freeze(artifactsById),
      limits: Object.freeze({ ...this.currentState.limits }),
    })
  }

  write(chunk: string): HtmlArtifactProtocolEvent[] {
    return applyHtmlArtifactProtocolChunk(this.currentState, chunk)
  }

  finish(): HtmlArtifactProtocolEvent[] {
    return finalizeHtmlArtifactProtocol(this.currentState)
  }

  getSnapshot(artifactId: string): HtmlArtifactSnapshot | null {
    const snapshot = this.currentState.artifactsById[artifactId]
    return snapshot ? { ...snapshot } : null
  }

  reset(): void {
    this.currentState = createHtmlArtifactProtocolStreamState(this.options)
  }
}

export type HtmlArtifactProtocolEvent =
  | { type: 'markdown'; text: string }
  | { type: 'artifact-open'; artifact: HtmlArtifactDescriptor; protocolText: string }
  | {
      type: 'artifact-update'
      artifact: HtmlArtifactDescriptor
      html: string
      isStreaming: boolean
      protocolText: string
    }
  | {
      type: 'artifact-patch'
      artifact: HtmlArtifactDescriptor
      patch: HtmlArtifactRenderPatch
      protocolText: string
    }
  | {
      type: 'artifact-diagnostic'
      artifact: HtmlArtifactDescriptor
      diagnostic: HtmlArtifactProtocolDiagnostic
      protocolText: string
    }
  | { type: 'artifact-close'; artifact: HtmlArtifactDescriptor; protocolText: string }

interface ParsedTag {
  raw: string
  attributes: Record<string, string>
}

export function createHtmlArtifactProtocolStreamState(
  options: HtmlArtifactProtocolStreamOptions = {}
): HtmlArtifactProtocolStreamState {
  const artifactsById: Record<string, HtmlArtifactSnapshot> = {}
  const limits = resolveProtocolLimits(options.limits)

  for (const artifact of options.initialArtifacts ?? []) {
    artifactsById[artifact.id] = {
      ...artifact,
      html: clipText(artifact.html, limits.maxArtifactHtmlLength),
      protocolText: artifact.protocolText
        ? clipText(artifact.protocolText, limits.maxArtifactProtocolTextLength)
        : artifact.protocolText,
    }
  }

  return {
    enabled: !!options.enabled,
    mode: 'markdown',
    buffer: '',
    activeArtifact: null,
    activeAction: null,
    artifactsById,
    anonymousArtifactCounter: 0,
    limits,
  }
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function resolveProtocolLimits(
  limits: HtmlArtifactProtocolLimits = {}
): Required<HtmlArtifactProtocolLimits> {
  return {
    maxActionPayloadLength: normalizeLimit(
      limits.maxActionPayloadLength,
      DEFAULT_MAX_ACTION_PAYLOAD_LENGTH
    ),
    maxArtifactHtmlLength: normalizeLimit(
      limits.maxArtifactHtmlLength,
      DEFAULT_MAX_ARTIFACT_HTML_LENGTH
    ),
    maxArtifactProtocolTextLength: normalizeLimit(
      limits.maxArtifactProtocolTextLength,
      DEFAULT_MAX_ARTIFACT_PROTOCOL_TEXT_LENGTH
    ),
    maxBufferLength: normalizeLimit(limits.maxBufferLength, DEFAULT_MAX_BUFFER_LENGTH),
  }
}

function clipText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength)
}

function clipTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength)
}

function clampArtifactTitle(title: string): string {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim()
  return normalizedTitle.slice(0, MAX_ARTIFACT_TITLE_LENGTH) || 'HTML Live Preview'
}

function normalizeExplicitArtifactId(id: string): string | null {
  const normalizedId = id
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ARTIFACT_ID_LENGTH)

  return normalizedId || null
}

function parsePositiveHeight(value: string | null): number | undefined {
  if (!value) return undefined

  const numericValue = +value
  if (!Number.isFinite(numericValue) || numericValue <= 0) return undefined

  return Math.max(160, Math.min(Math.round(numericValue), 1200))
}

function readArtifactProtocolVersion(value: string | null | undefined): string | null {
  if (!value) return HTML_ARTIFACT_PROTOCOL_VERSION

  const normalized = value.trim()
  return normalized === HTML_ARTIFACT_PROTOCOL_VERSION ? normalized : null
}

function parseTag(tagText: string, expectedName: string): ParsedTag | null {
  const openMatch = tagText.match(/^<([A-Za-z][\w:-]*)([\s\S]*)>$/)
  if (!openMatch || openMatch[1] !== expectedName) return null

  const attributes: Record<string, string> = {}
  const attributeText = openMatch[2] ?? ''
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null

  while ((match = attributePattern.exec(attributeText))) {
    const key = match[1]
    const value = match[2] ?? match[3] ?? ''
    attributes[key] = value
  }

  return { raw: tagText, attributes }
}

function findPartialProtocolStart(
  text: string,
  candidates: readonly string[] = PARTIAL_PROTOCOL_CANDIDATES
): number {
  const maxCandidateLength = Math.max(
    ...candidates.map((candidate) => candidate.length)
  )
  const startIndex = Math.max(0, text.length - maxCandidateLength + 1)

  for (let index = startIndex; index < text.length; index += 1) {
    const suffix = text.slice(index)
    if (
      suffix &&
      candidates.some((candidate) => candidate.startsWith(suffix))
    ) return index
  }

  return -1
}

function findTagEnd(text: string, openIndex: number): number {
  let quote: string | null = null

  for (let index = openIndex + 1; index < text.length; index += 1) {
    const char = text[index]

    if (quote) {
      if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '>') return index
  }

  return -1
}

function findHtmlTagEnd(text: string, openIndex: number): number {
  return findTagEnd(text, openIndex)
}

function emitMarkdown(events: HtmlArtifactProtocolEvent[], text: string): void {
  if (text) events.push({ type: 'markdown', text })
}

function ensureArtifactSnapshot(
  state: HtmlArtifactProtocolStreamState,
  artifact: HtmlArtifactDescriptor
): void {
  const existing = state.artifactsById[artifact.id]
  state.artifactsById[artifact.id] = {
    ...artifact,
    html: clipText(existing?.html ?? '', state.limits.maxArtifactHtmlLength),
    protocolText: clipText(
      existing?.protocolText ?? '',
      state.limits.maxArtifactProtocolTextLength
    ),
  }
}

function readArtifactProtocolText(
  state: HtmlArtifactProtocolStreamState,
  artifact: HtmlArtifactDescriptor
): string {
  return state.artifactsById[artifact.id]?.protocolText ?? ''
}

function appendArtifactProtocolText(
  state: HtmlArtifactProtocolStreamState,
  text: string
): void {
  if (!state.activeArtifact || !text) return

  const artifact = state.activeArtifact
  const existing = state.artifactsById[artifact.id] ?? { ...artifact, html: '', protocolText: '' }
  state.artifactsById[artifact.id] = {
    ...existing,
    protocolText: clipText(
      `${existing.protocolText ?? ''}${text}`,
      state.limits.maxArtifactProtocolTextLength
    ),
  }
}

function updateArtifactHtml(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  artifact: HtmlArtifactDescriptor,
  html: string,
  isStreaming: boolean
): void {
  const existing = state.artifactsById[artifact.id]
  const clippedHtml = clipText(html, state.limits.maxArtifactHtmlLength)
  state.artifactsById[artifact.id] = {
    ...artifact,
    html: clippedHtml,
    protocolText: existing?.protocolText ?? '',
  }
  events.push({
    type: 'artifact-update',
    artifact,
    html: clippedHtml,
    isStreaming,
    protocolText: readArtifactProtocolText(state, artifact),
  })
}

function readArtifactFromTag(
  tag: ParsedTag
): HtmlArtifactDescriptor | null {
  const rawId = tag.attributes.id ?? tag.attributes.artifactId
  if (typeof rawId !== 'string') return null

  const id = normalizeExplicitArtifactId(rawId)
  if (!id) return null

  const protocolVersion = readArtifactProtocolVersion(tag.attributes.version)
  if (!protocolVersion) return null

  const title = clampArtifactTitle(tag.attributes.title ?? id)
  const initialHeight = parsePositiveHeight(tag.attributes.height ?? null)
  const artifact = { id, protocolVersion, title }

  return initialHeight === undefined ? artifact : { ...artifact, initialHeight }
}

function readActionType(tag: ParsedTag): HtmlArtifactActionType {
  if (tag.attributes.type === 'append') return 'append'
  if (tag.attributes.type === 'style') return 'style'
  if (tag.attributes.type === 'script') return 'script'
  return 'replace'
}

function normalizePatchMetadata(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined

  const normalized = value.trim().slice(0, MAX_PATCH_METADATA_LENGTH)
  return normalized || undefined
}

function readActionEncoding(tag: ParsedTag): HtmlArtifactActionState['encoding'] {
  return tag.attributes.encoding === 'base64' ? 'base64' : undefined
}

function emitSafeMarkdownPrefix(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const partialStart = findPartialProtocolStart(state.buffer, MARKDOWN_PARTIAL_PROTOCOL_CANDIDATES)

  if (partialStart < 0) {
    const text = state.buffer
    state.buffer = ''
    emitMarkdown(events, text)
    return
  }

  const text = state.buffer.slice(0, partialStart)
  state.buffer = state.buffer.slice(partialStart)
  emitMarkdown(events, text)
}

function processMarkdownMode(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const openIndex = state.buffer.indexOf(ARTIFACT_OPEN)
  if (openIndex < 0) {
    emitSafeMarkdownPrefix(state, events)
    return
  }

  const before = state.buffer.slice(0, openIndex)
  emitMarkdown(events, before)
  const tagEnd = findTagEnd(state.buffer, openIndex)

  if (tagEnd < 0) {
    state.buffer = state.buffer.slice(openIndex)
    return
  }

  const tagText = state.buffer.slice(openIndex, tagEnd + 1)
  const parsedTag = parseTag(tagText, 'artifact')

  if (!parsedTag) {
    emitMarkdown(events, tagText)
    state.buffer = state.buffer.slice(tagEnd + 1)
    return
  }

  const artifact = readArtifactFromTag(parsedTag)
  if (!artifact) {
    emitMarkdown(events, tagText)
    state.buffer = state.buffer.slice(tagEnd + 1)
    return
  }

  state.activeArtifact = artifact
  state.activeAction = null
  state.mode = 'artifact'
  state.buffer = state.buffer.slice(tagEnd + 1)
  ensureArtifactSnapshot(state, artifact)
  appendArtifactProtocolText(state, tagText)
  events.push({
    type: 'artifact-open',
    artifact,
    protocolText: readArtifactProtocolText(state, artifact),
  })
}

function processArtifactMode(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const actionIndex = state.buffer.indexOf(PATCH_OPEN)
  const closeIndex = state.buffer.indexOf(ARTIFACT_CLOSE)
  const hasAction = actionIndex >= 0
  const hasClose = closeIndex >= 0

  if (!hasAction && !hasClose) {
    const partialStart = findPartialProtocolStart(state.buffer)
    state.buffer = partialStart >= 0 ? state.buffer.slice(partialStart) : ''
    return
  }

  if (hasClose && (!hasAction || closeIndex < actionIndex)) {
    const artifact = state.activeArtifact
    appendArtifactProtocolText(state, ARTIFACT_CLOSE)
    state.buffer = state.buffer.slice(closeIndex + ARTIFACT_CLOSE.length)
    state.activeArtifact = null
    state.activeAction = null
    state.mode = 'markdown'
    if (artifact) {
      events.push({
        type: 'artifact-close',
        artifact,
        protocolText: readArtifactProtocolText(state, artifact),
      })
    }
    return
  }

  const tagEnd = findTagEnd(state.buffer, actionIndex)
  if (tagEnd < 0) {
    state.buffer = state.buffer.slice(actionIndex)
    return
  }

  const tagText = state.buffer.slice(actionIndex, tagEnd + 1)
  const parsedTag = parseTag(tagText, 'patch')
  if (!parsedTag) {
    state.buffer = state.buffer.slice(tagEnd + 1)
    return
  }

  const activeArtifact = state.activeArtifact
  appendArtifactProtocolText(state, tagText)
  state.activeAction = {
    type: readActionType(parsedTag),
    target: normalizePatchMetadata(parsedTag.attributes.target),
    styleId: normalizePatchMetadata(parsedTag.attributes.id),
    scriptId: normalizePatchMetadata(parsedTag.attributes.id),
    encoding: readActionEncoding(parsedTag),
    baseHtml: activeArtifact ? state.artifactsById[activeArtifact.id]?.html ?? '' : '',
    html: '',
    emittedLength: 0,
    emittedDiagnostics: [],
  }
  state.mode = 'action'
  state.buffer = state.buffer.slice(tagEnd + 1)
}

function findSafeHtmlEmitEnds(html: string, startIndex: number): number[] {
  const ends: number[] = []
  let searchIndex = Math.max(0, startIndex)

  while (searchIndex < html.length) {
    const openIndex = html.indexOf('<', searchIndex)
    if (openIndex < 0) break

    if (html.startsWith('<!--', openIndex)) {
      const commentEnd = html.indexOf('-->', openIndex + 4)
      if (commentEnd < 0) break
      const endIndex = commentEnd + 3
      if (endIndex > startIndex) ends.push(endIndex)
      searchIndex = endIndex
      continue
    }

    const tagEnd = findHtmlTagEnd(html, openIndex)
    if (tagEnd < 0) break

    const tagText = html.slice(openIndex, tagEnd + 1)
    const tagMatch = tagText.match(/^<\/?\s*([A-Za-z][\w:-]*)\b/)
    const tagName = tagMatch?.[1]?.toLowerCase()
    const isClosingTag = /^<\//.test(tagText)
    const isSelfClosing = /\/\s*>$/.test(tagText)
    const isVoidTag = !!tagName && VOID_HTML_TAGS.has(tagName)
    const endIndex = tagEnd + 1

    if ((isClosingTag || isSelfClosing || isVoidTag) && endIndex > startIndex) {
      ends.push(endIndex)
    }

    searchIndex = endIndex
  }

  return ends
}

function findSafeCssEmitEnds(css: string, startIndex: number): number[] {
  const ends: number[] = []
  let quote: string | null = null
  let escaped = false
  let inComment = false
  let braceDepth = 0

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    const nextChar = css[index + 1]

    if (inComment) {
      if (char === '*' && nextChar === '/') {
        inComment = false
        index += 1
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = null
      continue
    }

    if (char === '/' && nextChar === '*') {
      inComment = true
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '{') {
      braceDepth += 1
      continue
    }

    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1
      if (braceDepth === 0 && index + 1 > startIndex) ends.push(index + 1)
    }
  }

  return ends
}

function decodeUtf8Bytes(bytes: number[]): string {
  let output = ''

  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index] ?? 0

    if (first < 0x80) {
      output += String.fromCharCode(first)
      continue
    }

    if (first >= 0xc0 && first < 0xe0) {
      const second = bytes[index + 1] ?? 0
      output += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f))
      index += 1
      continue
    }

    if (first >= 0xe0 && first < 0xf0) {
      const second = bytes[index + 1] ?? 0
      const third = bytes[index + 2] ?? 0
      output += String.fromCharCode(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      )
      index += 2
      continue
    }

    if (first >= 0xf0 && first < 0xf8) {
      const second = bytes[index + 1] ?? 0
      const third = bytes[index + 2] ?? 0
      const fourth = bytes[index + 3] ?? 0
      const codePoint =
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f)
      output += String.fromCodePoint(codePoint)
      index += 3
      continue
    }

    output += '\uFFFD'
  }

  return output
}

function decodeBase64Utf8(value: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const normalized = value.replace(/\s+/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bitCount = 0

  for (const char of normalized) {
    if (char === '=') break

    const nextValue = alphabet.indexOf(char)
    if (nextValue < 0) return null

    buffer = (buffer << 6) | nextValue
    bitCount += 6

    if (bitCount >= 8) {
      bitCount -= 8
      bytes.push((buffer >> bitCount) & 0xff)
    }
  }

  return decodeUtf8Bytes(bytes)
}

function readActionPatchId(action: HtmlArtifactActionState): string | undefined {
  return action.scriptId || action.styleId || action.target
}

function emitActionDiagnostic(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  code: HtmlArtifactProtocolDiagnosticCode,
  message: string
): void {
  const artifact = state.activeArtifact
  const action = state.activeAction
  if (!artifact || !action) return

  const patchId = readActionPatchId(action)
  const diagnosticKey = `${code}:${action.type}:${patchId ?? ''}`
  if (action.emittedDiagnostics.includes(diagnosticKey)) return

  action.emittedDiagnostics.push(diagnosticKey)
  events.push({
    type: 'artifact-diagnostic',
    artifact,
    diagnostic: {
      code,
      message,
      phase: 'protocol',
      patchType: action.type,
      patchId,
    },
    protocolText: readArtifactProtocolText(state, artifact),
  })
}

function readActionPayload(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  action: HtmlArtifactActionState,
  endIndex: number
): string {
  const rawPayload = action.html.slice(0, endIndex)

  if (action.encoding !== 'base64') return rawPayload

  const decoded = decodeBase64Utf8(rawPayload)
  if (decoded !== null) return decoded

  emitActionDiagnostic(
    state,
    events,
    'invalid-base64',
    `Invalid base64 payload in ${action.type} patch.`
  )
  return rawPayload
}

function emitActionHtmlAtLength(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  endIndex: number,
  isStreaming: boolean
): void {
  const artifact = state.activeArtifact
  const action = state.activeAction
  if (!artifact || !action) return
  if (endIndex <= action.emittedLength) return

  const html = readActionPayload(state, events, action, endIndex)

  if (action.type === 'style') {
    events.push({
      type: 'artifact-patch',
      artifact,
      patch: {
        type: 'style',
        styleId: action.styleId || action.target || 'default',
        css: html,
      },
      protocolText: readArtifactProtocolText(state, artifact),
    })
    action.emittedLength = endIndex
    return
  }

  if (action.type === 'script') {
    events.push({
      type: 'artifact-patch',
      artifact,
      patch: {
        type: 'script',
        scriptId: action.scriptId || action.target || 'default',
        code: html,
      },
      protocolText: readArtifactProtocolText(state, artifact),
    })
    action.emittedLength = endIndex
    return
  }

  if (action.target) {
    events.push({
      type: 'artifact-patch',
      artifact,
      patch: {
        type: action.type,
        target: action.target,
        html:
          action.type === 'append' && action.encoding !== 'base64'
            ? action.html.slice(action.emittedLength, endIndex)
            : html,
      },
      protocolText: readArtifactProtocolText(state, artifact),
    })
    action.emittedLength = endIndex
    return
  }

  const rootHtml =
    action.type === 'append'
      ? `${action.baseHtml}${html}`
      : html
  updateArtifactHtml(state, events, artifact, rootHtml, isStreaming)
  action.emittedLength = endIndex
}

function emitSafeActionProgress(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  isStreaming: boolean,
  final: boolean
): void {
  const action = state.activeAction
  if (!action) return

  const safeEnds =
    action.encoding === 'base64'
      ? []
      : action.type === 'style'
      ? findSafeCssEmitEnds(action.html, action.emittedLength)
      : action.type === 'script'
        ? []
      : findSafeHtmlEmitEnds(action.html, action.emittedLength)
  const emitEnds = [...safeEnds]

  if (final && action.emittedLength < action.html.length) {
    const finalEnd = action.html.length
    if (emitEnds.at(-1) !== finalEnd) emitEnds.push(finalEnd)
  }

  for (const endIndex of emitEnds) {
    emitActionHtmlAtLength(state, events, endIndex, isStreaming)
  }
}

function appendActionHtml(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  htmlChunk: string,
  isStreaming: boolean,
  final = false,
  trackProtocol = true
): void {
  if (!htmlChunk && isStreaming && !final) return

  const action = state.activeAction
  if (!state.activeArtifact || !action) return

  if (trackProtocol) appendArtifactProtocolText(state, htmlChunk)
  action.html = clipText(
    `${action.html}${htmlChunk}`,
    state.limits.maxActionPayloadLength
  )
  emitSafeActionProgress(state, events, isStreaming, final)
}

function completePatchAction(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const action = state.activeAction
  if (!action) return

  emitSafeActionProgress(state, events, true, true)
  if (!action.target && action.type !== 'style') return
}

function processActionMode(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const closeIndex = state.buffer.indexOf(PATCH_CLOSE)
  const artifactCloseIndex = state.buffer.indexOf(ARTIFACT_CLOSE)

  if (artifactCloseIndex >= 0 && (closeIndex < 0 || artifactCloseIndex < closeIndex)) {
    const artifact = state.activeArtifact
    const htmlChunk = state.buffer.slice(0, artifactCloseIndex)
    appendArtifactProtocolText(state, `${htmlChunk}${ARTIFACT_CLOSE}`)
    appendActionHtml(state, events, htmlChunk, true, true, false)
    state.buffer = state.buffer.slice(artifactCloseIndex + ARTIFACT_CLOSE.length)
    state.activeAction = null
    state.activeArtifact = null
    state.mode = 'markdown'
    if (artifact) {
      events.push({
        type: 'artifact-close',
        artifact,
        protocolText: readArtifactProtocolText(state, artifact),
      })
    }
    return
  }

  if (closeIndex < 0) {
    const partialStart = findPartialProtocolStart(state.buffer)
    if (partialStart < 0) {
      const htmlChunk = state.buffer
      state.buffer = ''
      appendActionHtml(state, events, htmlChunk, true)
      return
    }

    const htmlChunk = state.buffer.slice(0, partialStart)
    state.buffer = state.buffer.slice(partialStart)
    appendActionHtml(state, events, htmlChunk, true)
    return
  }

  const htmlChunk = state.buffer.slice(0, closeIndex)
  appendArtifactProtocolText(state, `${htmlChunk}${PATCH_CLOSE}`)
  appendActionHtml(state, events, htmlChunk, true, true, false)
  state.buffer = state.buffer.slice(closeIndex + PATCH_CLOSE.length)
  state.activeAction = null
  state.mode = 'artifact'
}

function processProtocolBuffer(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  let guard = 0

  while (state.buffer && guard < 100) {
    guard += 1
    const previousMode = state.mode
    const previousBuffer = state.buffer

    if (state.mode === 'markdown') {
      processMarkdownMode(state, events)
    } else if (state.mode === 'artifact') {
      processArtifactMode(state, events)
    } else {
      processActionMode(state, events)
    }

    if (state.mode === previousMode && state.buffer === previousBuffer) break
  }
}

export function applyHtmlArtifactProtocolChunk(
  state: HtmlArtifactProtocolStreamState,
  chunk: string
): HtmlArtifactProtocolEvent[] {
  if (!chunk) return []
  if (!state.enabled) return [{ type: 'markdown', text: chunk }]

  const events: HtmlArtifactProtocolEvent[] = []
  state.buffer += chunk
  processProtocolBuffer(state, events)
  state.buffer = clipTail(state.buffer, state.limits.maxBufferLength)
  return events
}

export function finalizeHtmlArtifactProtocol(
  state: HtmlArtifactProtocolStreamState
): HtmlArtifactProtocolEvent[] {
  if (!state.enabled) return []

  const events: HtmlArtifactProtocolEvent[] = []

  if (state.mode === 'action') {
    appendActionHtml(state, events, state.buffer, false)
    completePatchAction(state, events)
    state.buffer = ''
    state.activeAction = null
    if (state.activeArtifact) {
      events.push({
        type: 'artifact-close',
        artifact: state.activeArtifact,
        protocolText: readArtifactProtocolText(state, state.activeArtifact),
      })
    }
  } else if (state.mode === 'artifact') {
    if (state.activeArtifact) {
      appendArtifactProtocolText(state, state.buffer)
      events.push({
        type: 'artifact-close',
        artifact: state.activeArtifact,
        protocolText: readArtifactProtocolText(state, state.activeArtifact),
      })
    }
    state.buffer = ''
  } else if (state.buffer) {
    emitMarkdown(events, state.buffer)
    state.buffer = ''
  }

  state.mode = 'markdown'
  state.activeArtifact = null
  state.activeAction = null
  return events
}
