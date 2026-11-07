/**
 * 灵泡 CSS 动画的几何契约。
 *
 * 听音乐时的摇摆由 `.lp-dance` 上的 rAF transform 驱动；SVG 分组不写
 * `transform-origin` 时浏览器按 0 0（画布左上角）当支点，整只灵泡会绕左上角
 * 甩出去。原型 `design/characters/lingpao/sheets/lingpao-groove.html` 与设计提案
 * 都要求绕身体底部 (90, 209) 旋转（像摇头），这里守住这个支点。
 */
// @ts-ignore -- node:fs 只有测试用；项目 tsconfig 不引入 Node 类型
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./lingpao.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('灵泡 CSS 动画', () => {
  it('sways around the body base instead of the canvas corner', () => {
    expect(rule('.lingpao .lp-dance')).toMatch(/transform-box:\s*view-box/)
    expect(rule('.lingpao .lp-dance')).toMatch(/transform-origin:\s*90px\s+209px/)
  })

  it('breathes around the same base point', () => {
    expect(rule('.lingpao .lp-breathe')).toMatch(/transform-origin:\s*90px\s+209px/)
  })

  it('softens pose changes instead of snapping', () => {
    // 状态之间 tilt 差 3°~5°：必须有过渡。
    expect(rule('.lingpao .lp-tilt')).toMatch(/transition:\s*transform/)
    // 换眼靠遮罩：闭眼帧里换图形，支点在两眼之间。
    expect(rule('.lingpao .lp-eyes')).toMatch(/transform-origin:\s*90px\s+152px/)
    expect(rule('.lingpao .lp-eyes.cover')).toMatch(/scaleY/)
  })
})