/**
 * 把 design/anim/tracks.manifest.json 烘焙成运行时多轨目录：
 *
 *   public/pet/anim/manifest.json          # 运行时索引（路径已归一化）
 *   public/pet/anim/<track-id>/track_struct.json
 *   public/pet/anim/<track-id>/frames/*.webp
 *
 * - frameSequence 帧只拷相位用到的 from–to，目录改成 frames/。
 * - animatedWebp 若已在 public/ 下就改成根绝对路径；否则拷到轨目录。
 *
 * 该目录是生成物（见 .gitignore），npm 的 predev / prebuild / pretest 会自动跑。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const designRoot = join(root, 'design')
const manifestPath = join(designRoot, 'anim', 'tracks.manifest.json')
const publicRoot = join(root, 'public')
const outRoot = join(publicRoot, 'pet', 'anim')

const design = JSON.parse(readFileSync(manifestPath, 'utf8'))
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

const runtimeManifest = {
  version: design.version ?? '1.0.0',
  defaultTrack: design.defaultTrack,
  generatedFrom: 'design/anim/tracks.manifest.json',
  tracks: [],
}

const seen = new Set()

/** 动画 WebP 的总时长（ANMF 帧时长之和，毫秒）；读不到时返回 undefined。 */
function webpDurationMs(path) {
  const buffer = readFileSync(path)
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return undefined
  }
  let offset = 12
  let total = 0
  let frames = 0
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const data = offset + 8
    if (type === 'ANMF' && data + 16 <= buffer.length) {
      total += buffer[data + 12] | (buffer[data + 13] << 8) | (buffer[data + 14] << 16)
      frames += 1
    }
    offset = data + size + (size & 1)
  }
  return frames > 0 ? total : undefined
}

function framesOf(asset, baseDir) {
  const dir = resolve(baseDir, asset.dir ?? 'tracks')
  const pattern = asset.pattern ?? 'frame{NNN}.webp'
  const zeroPad = asset.zeroPad ?? 3
  if (!Number.isInteger(asset.from) || !Number.isInteger(asset.to) || asset.to < asset.from) {
    throw new Error(`frameSequence 的 from/to 不合法：${JSON.stringify(asset)}`)
  }
  const files = []
  for (let frame = asset.from; frame <= asset.to; frame += 1) {
    const name = pattern.replace('{NNN}', String(frame).padStart(zeroPad, '0'))
    const source = join(dir, name)
    if (!existsSync(source)) throw new Error(`缺少帧文件：${source}`)
    files.push({ name, source })
  }
  return { pattern, zeroPad, files }
}

function bakePhase(phaseName, phase, structPath, outDir) {
  const asset = phase.asset
  if (!asset) throw new Error(`${structPath} 的相位 ${phaseName} 缺少 asset`)

  if (asset.type === 'frameSequence') {
    const { pattern, zeroPad, files } = framesOf(asset, dirname(structPath))
    const outFrames = join(outDir, 'frames')
    mkdirSync(outFrames, { recursive: true })
    for (const file of files) copyFileSync(file.source, join(outFrames, file.name))
    return {
      ...phase,
      asset: { ...asset, dir: 'frames', pattern, zeroPad },
    }
  }

  if (asset.type === 'animatedWebp') {
    const source = resolve(dirname(structPath), asset.src)
    if (!existsSync(source)) throw new Error(`${structPath} 的 WebP 不存在：${source}`)
    const durationMs = webpDurationMs(source)
    const timing = durationMs ? { durationMs } : {}
    const fromPublic = relative(publicRoot, source)
    if (!fromPublic.startsWith('..') && !fromPublic.startsWith(`..${sep}`)) {
      const src = `/${fromPublic.split(sep).join('/')}`
      return { ...phase, asset: { ...asset, src, ...timing } }
    }
    const name = basename(source)
    copyFileSync(source, join(outDir, name))
    return { ...phase, asset: { ...asset, src: name, ...timing } }
  }

  throw new Error(`${structPath} 的相位 ${phaseName} 使用了未知 asset.type：${asset.type}`)
}

for (const entry of design.tracks ?? []) {
  if (seen.has(entry.id)) throw new Error(`轨道 id 重复：${entry.id}`)
  seen.add(entry.id)

  const structPath = resolve(join(designRoot, 'anim'), entry.path)
  if (!existsSync(structPath)) throw new Error(`找不到轨道结构：${structPath}`)
  const struct = JSON.parse(readFileSync(structPath, 'utf8'))
  const outDir = join(outRoot, entry.id)
  mkdirSync(outDir, { recursive: true })

  const phases = {}
  for (const [name, phase] of Object.entries(struct.phases ?? {})) {
    phases[name] = bakePhase(name, phase, structPath, outDir)
  }

  const runtimeStruct = {
    ...struct,
    paths: { struct: 'track_struct.json' },
    phases,
  }
  writeFileSync(join(outDir, 'track_struct.json'), `${JSON.stringify(runtimeStruct, null, 2)}\n`)

  runtimeManifest.tracks.push({
    id: entry.id,
    displayName: entry.displayName,
    ...(entry.tags ? { tags: entry.tags } : {}),
    path: `${entry.id}/track_struct.json`,
  })
}

writeFileSync(join(outRoot, 'manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)
console.log(`baked ${runtimeManifest.tracks.length} tracks → ${relative(root, outRoot).split(sep).join('/')}`)
