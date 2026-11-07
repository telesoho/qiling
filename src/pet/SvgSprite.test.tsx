import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { lingpaoAriaLabel, poseForRuntime, type LingpaoRuntimeInput } from './lingpao'
import { LingpaoFigure } from './SvgSprite'

function render(input: Partial<LingpaoRuntimeInput> = {}): string {
  const runtime: LingpaoRuntimeInput = {
    stateId: 'idle',
    speaking: false,
    holding: false,
    music: null,
    ...input,
  }
  const pose = poseForRuntime(runtime)
  return renderToStaticMarkup(
    <LingpaoFigure
      pose={pose}
      ariaLabel={lingpaoAriaLabel(runtime)}
      holding={runtime.holding}
      dancing={runtime.music !== null && !runtime.holding}
      mood={runtime.music}
    />,
  )
}

describe('灵泡 SVG', () => {
  it('renders the idle skeleton at the contract size', () => {
    const html = render()
    expect(html).toContain('width="180"')
    expect(html).toContain('height="240"')
    expect(html).toContain('viewBox="0 0 180 240"')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="器灵，待机"')
    expect(html).toContain('data-pose-eye="open"')
    expect(html).toContain('data-part="body"')
    expect(html).toContain('lp-ground')
    expect(html).not.toContain('lp-phones on')
    expect(html).not.toContain('lp-notes on')
  })

  it('keeps the eye group class the blink and eye-cover selectors need', () => {
    expect(render({ music: 'groove' })).toContain('data-part="eyes" class="lp-eyes"')
  })

  it('sticks to the 8KB budget', () => {
    expect(render().length).toBeLessThanOrEqual(8 * 1024)
  })

  it('opens the explain mouth only while speaking', () => {
    expect(render({ stateId: 'explain' })).not.toContain('lp-mouth-talk')
    expect(render({ stateId: 'explain', speaking: true })).toContain('lp-mouth-talk')
  })

  it('draws the bulb for explaining and sparkles for advantage', () => {
    expect(render({ stateId: 'explain', speaking: true })).toContain('data-part="prop"')
    const advantage = render({ stateId: 'advantage' })
    expect(advantage).toContain('lp-spark')
    expect(advantage).toContain('data-pose-eye="star"')
  })

  it('closes the eyes and wears headphones when calm', () => {
    const html = render({ music: 'calm' })
    expect(html).toContain('data-mood="calm"')
    expect(html).toContain('data-pose-eye="happy"')
    expect(html).toContain('data-pose-mouth="smile"')
    expect(html).toContain('lp-phones on')
    expect(html).toContain('lp-notes on')
    expect(html).not.toContain('lp-cheeks on')
    expect(html).toContain('is-dancing')
  })

  it('smiles with open eyes and cheeks when grooving', () => {
    const html = render({ music: 'groove' })
    expect(html).toContain('data-mood="groove"')
    expect(html).toContain('data-pose-eye="open"')
    expect(html).toContain('data-pose-mouth="smile-wide"')
    expect(html).toContain('lp-cheeks on')
    expect(html).toContain('lp-phones on')
    expect(html).toContain('is-dancing')
  })

  it('stretches the picked-up pose and stops dancing', () => {
    const html = render({ stateId: 'explain', speaking: true, holding: true, music: 'intense' })
    expect(html).toContain('is-holding')
    expect(html).not.toContain('is-dancing')
    expect(html).toContain('data-pose-eye="wide"')
    expect(html).toContain('data-pose-mouth="o"')
    expect(html).toContain('aria-label="器灵，被拎起"')
  })

  it('labels the music pose for screen readers', () => {
    expect(render({ music: 'intense' })).toContain('aria-label="器灵，听音乐·激烈"')
    expect(render({ stateId: 'think' })).toContain('aria-label="器灵，思考"')
  })
})