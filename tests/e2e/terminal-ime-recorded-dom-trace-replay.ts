import type { Page } from '@stablyai/playwright-test'
import {
  samplePreeditOverlay,
  type PreeditOverlaySample
} from './terminal-ime-preedit-overlay-probe'

/**
 * Replays a recorded IME DOM trace against the live terminal one event at a time, sampling the
 * preedit overlay after every composition event.
 *
 * Each event costs a CDP round-trip. That is deliberate: it lets xterm's deferred composition
 * timers and the renderer's layout run between events the way they do under a real IME, so a
 * per-event geometry sample measures an overlay that has actually been positioned.
 */
export type RecordedImeDomEvent = {
  type: string
  data?: string
  inputType?: string
  key?: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  value?: string
  selectionStart?: number
  selectionEnd?: number
}

export type RecordedImeDomTrace = {
  recordedFrom: string
  inputFramework: string
  engine: string
  note: string
  onData?: { data: string }[]
  dom: RecordedImeDomEvent[]
}

export type ReplayedCompositionSample = {
  index: number
  type: string
  data: string
  compositionOpen: boolean
  overlay: PreeditOverlaySample
}

export type RecordedTraceReplay = {
  samples: ReplayedCompositionSample[]
  onData: string
}

const COMPOSITION_EVENT_TYPES = new Set(['compositionstart', 'compositionupdate', 'compositionend'])

async function startRecordedTraceOnDataCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __recordedTraceOnData: string[] }
    target.__recordedTraceOnData = []
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane for the recorded trace replay')
    }
    pane.terminal.onData((data) => target.__recordedTraceOnData.push(data))
  })
}

async function dispatchRecordedEvent(page: Page, recorded: RecordedImeDomEvent): Promise<void> {
  await page.evaluate((event: RecordedImeDomEvent) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    if (!textarea) {
      throw new Error('xterm helper textarea is not focused')
    }
    if (event.type === 'keydown' || event.type === 'keyup') {
      const keyboard = new KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        isComposing: event.isComposing,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(keyboard, 'keyCode', { value: event.keyCode })
      textarea.dispatchEvent(keyboard)
    } else if (event.type === 'input' || event.type === 'beforeinput') {
      textarea.dispatchEvent(
        new InputEvent(event.type, {
          bubbles: true,
          cancelable: event.type === 'beforeinput',
          composed: true,
          data: event.data ?? null,
          inputType: event.inputType ?? '',
          isComposing: event.isComposing
        })
      )
    } else {
      textarea.dispatchEvent(
        new CompositionEvent(event.type, {
          bubbles: true,
          data: event.data ?? ''
        })
      )
    }
    // The recorded value/selection is the state *after* the event, so applying it here leaves the
    // textarea holding exactly the state the next recorded event was dispatched against.
    if (event.value !== undefined) {
      textarea.value = event.value
    }
    if (event.selectionStart !== undefined && event.selectionEnd !== undefined) {
      textarea.setSelectionRange(event.selectionStart, event.selectionEnd)
    }
  }, recorded)
}

export async function replayRecordedImeDomTrace(
  page: Page,
  trace: RecordedImeDomTrace
): Promise<RecordedTraceReplay> {
  await startRecordedTraceOnDataCapture(page)

  const samples: ReplayedCompositionSample[] = []
  let compositionOpen = false

  for (const [index, recorded] of trace.dom.entries()) {
    await dispatchRecordedEvent(page, recorded)
    if (!COMPOSITION_EVENT_TYPES.has(recorded.type)) {
      continue
    }
    if (recorded.type === 'compositionstart') {
      compositionOpen = true
    }
    samples.push({
      index,
      type: recorded.type,
      data: recorded.data ?? '',
      compositionOpen,
      overlay: await samplePreeditOverlay(page)
    })
    if (recorded.type === 'compositionend') {
      compositionOpen = false
    }
  }

  const onData = await page.evaluate(() =>
    ((window as unknown as { __recordedTraceOnData?: string[] }).__recordedTraceOnData ?? []).join(
      ''
    )
  )
  return { samples, onData }
}
