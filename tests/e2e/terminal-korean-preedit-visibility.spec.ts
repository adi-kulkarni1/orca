/**
 * Headless end-to-end coverage for 2-Set Korean terminal input, asserting what the user sees.
 *
 * Two IME defects shipped past a suite of ~3000 passing IME assertions. Both were invisible to it
 * for the same reason: every assertion was about bytes reaching the PTY, and a preedit rendered
 * into a hidden overlay satisfies all of them while the user composes blind. The real-geometry
 * coverage that would have caught it existed, but was `@headful`, env-gated and macOS-only, so it
 * never ran in CI.
 *
 * This file closes that gap. Composition is driven through CDP `Input.imeSetComposition`, which
 * opens a genuine Chromium composition session with no native IME, no accessibility grant and no
 * system input source — so the geometry assertions run in the normal headless CI project.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  commitImeText,
  composeHangulSyllable,
  dispatchPlainEnter,
  dispatchResumedCompositionUpdate,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import {
  expectPreeditHidden,
  expectPreeditRendered,
  samplePreeditOverlay
} from './terminal-ime-preedit-overlay-probe'
import {
  replayRecordedImeDomTrace,
  type RecordedImeDomTrace
} from './terminal-ime-recorded-dom-trace-replay'

/** 2-Set Korean maps each jamo to a QWERTY position; the IME rewrites `key` to the jamo itself. */
const JAMO: Record<string, ImeKeyIdentity> = {
  ㅎ: { key: 'ㅎ', code: 'KeyG', keyCode: 71 },
  ㅏ: { key: 'ㅏ', code: 'KeyK', keyCode: 75 },
  ㄴ: { key: 'ㄴ', code: 'KeyS', keyCode: 83 },
  ㄱ: { key: 'ㄱ', code: 'KeyR', keyCode: 82 },
  ㅡ: { key: 'ㅡ', code: 'KeyM', keyCode: 77 },
  ㄹ: { key: 'ㄹ', code: 'KeyF', keyCode: 70 }
}

/** ㅎ → ㅏ → ㄴ assembles 한; the preedit shows the partially assembled syllable at each step. */
const HAN_FRAMES = [
  { jamoKey: JAMO['ㅎ'], preedit: 'ㅎ' },
  { jamoKey: JAMO['ㅏ'], preedit: '하' },
  { jamoKey: JAMO['ㄴ'], preedit: '한' }
] as const

/** ㄱ → ㅡ → ㄹ assembles 글. */
const GEUL_FRAMES = [
  { jamoKey: JAMO['ㄱ'], preedit: 'ㄱ' },
  { jamoKey: JAMO['ㅡ'], preedit: '그' },
  { jamoKey: JAMO['ㄹ'], preedit: '글' }
] as const

const RECORDED_TRACE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'windows-wsl-2set-hangul-dom-trace.json'), 'utf8')
) as RecordedImeDomTrace

type KoreanTerminalArena = {
  page: Page
  session: CDPSession
  ptyId: string
}

async function openTerminalArena(page: Page): Promise<{ ptyId: string; session: CDPSession }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const session = await page.context().newCDPSession(page)
  return { ptyId, session }
}

async function teardownTerminalArena(
  arena: KoreanTerminalArena,
  testInfo: TestInfo,
  evidenceName: string,
  interrupt: boolean
): Promise<void> {
  await attachTerminalImeBoundaryEvidence(arena.page, testInfo, evidenceName).catch(() => undefined)
  await disposeTerminalImeBoundaryProbe(arena.page).catch(() => undefined)
  await arena.session.detach().catch(() => undefined)
  if (interrupt) {
    await sendToTerminal(arena.page, arena.ptyId, '\x03').catch(() => undefined)
  }
}

test.describe('Terminal 2-Set Korean preedit visibility', () => {
  test('shows every assembling jamo at non-zero size and commits the syllable ahead of the newline', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const { ptyId, session } = await openTerminalArena(orcaPage)
    const arena: KoreanTerminalArena = { page: orcaPage, session, ptyId }
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, reader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)

      await expectPreeditHidden(orcaPage, 'before composing')

      for (const frame of HAN_FRAMES) {
        await composeHangulSyllable(session, orcaPage, [frame])
        await expectPreeditRendered(orcaPage, frame.preedit, `composing ${frame.preedit}`)
      }

      await commitImeText(session, '한')
      await expectPreeditHidden(orcaPage, 'after committing 한')

      await dispatchPlainEnter(session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from('한\n').toString('hex')])

      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      // The ordering the user reported as broken: the syllable must precede the newline.
      expect(trace.onData.join('')).toBe('한\r')
      completed = true
    } finally {
      await teardownTerminalArena(arena, testInfo, 'korean-preedit-visibility', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  test('keeps a preedit the IME resumes without a compositionstart visible @ime-known-broken', async ({
    orcaPage
  }, testInfo) => {
    // Red on `main`, by design. xterm adds `.active` to the overlay only in its `compositionstart`
    // handler, so a preedit resumed by a bare `compositionupdate` is written into a hidden element
    // and the user composes blind while the committed bytes still land correctly — which is why no
    // byte-level assertion ever saw it. Pre-existing and broken in every shipped build; the parked
    // eight-line fix in xterm's own composition helper closes it, and Playwright will fail the run
    // until the `test.fail()` marker below is deleted.
    test.fail(true, 'the resumed preedit is written into an overlay xterm never marks active')
    const { ptyId, session } = await openTerminalArena(orcaPage)
    const arena: KoreanTerminalArena = { page: orcaPage, session, ptyId }
    let completed = false
    try {
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)

      // Synthesised, not replayed — see dispatchResumedCompositionUpdate for why the recorded
      // corpus cannot supply this ordering and why it is still reachable in production.
      await dispatchResumedCompositionUpdate(orcaPage, '한')

      const sample = await samplePreeditOverlay(orcaPage)
      expect(sample.found, 'no composition overlay exists').toBe(true)
      expect(sample.text, 'the resumed preedit text never reached the overlay').toBe('한')
      expect(
        sample.rect.width,
        'the resumed preedit was written into an overlay with zero width — the user composes blind'
      ).toBeGreaterThan(0)
      expect(sample.rect.height, 'the resumed preedit overlay has zero height').toBeGreaterThan(0)
      completed = true
    } finally {
      await teardownTerminalArena(arena, testInfo, 'korean-resumed-preedit', !completed)
    }
  })

  test('renders the preedit at every update of a recorded Windows/WSL Hangul session', async ({
    orcaPage
  }, testInfo) => {
    const { ptyId, session } = await openTerminalArena(orcaPage)
    const arena: KoreanTerminalArena = { page: orcaPage, session, ptyId }
    let completed = false
    try {
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)

      const replay = await replayRecordedImeDomTrace(orcaPage, RECORDED_TRACE)
      const updates = replay.samples.filter(
        (sample) => sample.type === 'compositionupdate' && sample.data.length > 0
      )
      // If the fixture is ever replaced with one that carries no updates this assertion keeps the
      // rest of the test from passing vacuously.
      expect(updates.length, 'the recorded trace carries no composition updates').toBe(37)

      const invisible = updates.filter(
        (sample) => sample.overlay.rect.width === 0 || sample.overlay.rect.height === 0
      )
      expect(
        invisible.map((sample) => ({ index: sample.index, data: sample.data })),
        'these recorded preedit frames were written into an overlay with no size'
      ).toEqual([])

      const committed = replay.samples
        .filter((sample) => sample.type === 'compositionend' && sample.data.length > 0)
        .map((sample) => sample.data)
      expect(committed.join('')).toBe('문제모르겠네안녕하세요')
      completed = true
    } finally {
      await teardownTerminalArena(arena, testInfo, 'korean-recorded-trace-preedit', !completed)
    }
  })

  test('loses and duplicates nothing when back-to-back syllables commit at full speed', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const { ptyId, session } = await openTerminalArena(orcaPage)
    const arena: KoreanTerminalArena = { page: orcaPage, session, ptyId }
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, reader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)

      // No settle time between frames or between syllables: the cadence a fast typist produces,
      // and the one that used to drop or double a syllable at the boundary.
      for (let repetition = 0; repetition < 4; repetition += 1) {
        await composeHangulSyllable(session, orcaPage, HAN_FRAMES, 0)
        await commitImeText(session, '한')
        await composeHangulSyllable(session, orcaPage, GEUL_FRAMES, 0)
        await commitImeText(session, '글')
      }
      await dispatchPlainEnter(session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from(`${'한글'.repeat(4)}\n`).toString('hex')])

      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(trace.onData.join('')).toBe(`${'한글'.repeat(4)}\r`)
      completed = true
    } finally {
      await teardownTerminalArena(arena, testInfo, 'korean-fast-cadence', !completed)
      removeTerminalImeByteReader(reader)
    }
  })
})
