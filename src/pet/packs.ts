/**
 * 角色资源包的运行时加载。
 *
 * 后端把 `pet.json` 的 action 编译成规范里的运行时条目：
 *   id   = `<characterId>-<action>`
 *   tags = [action, characterId]（姿势动作再加 "pose"）
 * 这里只负责把条目和 `assetBase` 拼成 AnimLibrary，并整理待机节拍。
 */
import { invoke } from '@tauri-apps/api/core'
import {
  BUILTIN_CHARACTER_ID,
  createLibrary,
  loadAnimLibrary,
  normalizeTrack,
  type AnimLibrary,
} from './anim'
import {
  breathBeatOption,
  builtinBeatOptions,
  packBeatOptions,
  type IdleBeatOption,
  type PackBeatDecl,
} from './states'
import { inTauri } from './sync'

export const CHARACTER_EVENT = 'qiling-character-changed'

export type CharacterRenderer = 'svg' | 'webp'

export interface ActiveCharacter {
  id: string
  name: string
  builtin: boolean
  /** 可选：旧数据没有这个字段时按 webp 处理。 */
  renderer?: CharacterRenderer
}

export interface CharacterSummary extends ActiveCharacter {
  active: boolean
  version?: string
  author?: string
  description?: string
  thumbnailUrl?: string
  trackCount?: number
  pickupMode?: 'animated' | 'window-only'
  installedAt?: number
}

export interface PacksView {
  activeId: string
  storageDir: string
  characters: CharacterSummary[]
}

export type PackTrackStruct = Parameters<typeof normalizeTrack>[1]

export interface PackTrackEntry {
  id: string
  displayName?: string
  tags: string[]
  path: string
  struct: PackTrackStruct
}

export interface PackRuntime {
  character: ActiveCharacter
  assetBase: string
  tracks: PackTrackEntry[]
  idleBeats: PackBeatDecl[]
}

export interface CharacterAssets {
  character: ActiveCharacter
  renderer: CharacterRenderer
  /** SVG 角色没有位图轨，这里是 null。 */
  library: AnimLibrary | null
  beats: IdleBeatOption[]
}

/** 默认角色：灵泡（SVG 骨架）。 */
export const DEFAULT_CHARACTER: ActiveCharacter = {
  id: 'lingpao',
  name: '灵泡',
  builtin: true,
  renderer: 'svg',
}

/** 第二内置角色：诗琚（位图轨，走 bake 产物）。 */
export const SHIJU_CHARACTER: ActiveCharacter = {
  id: BUILTIN_CHARACTER_ID,
  name: '诗琚',
  builtin: true,
  renderer: 'webp',
}

export function rendererOf(character: ActiveCharacter): CharacterRenderer {
  return character.renderer === 'svg' ? 'svg' : 'webp'
}

function previewCharacter(): ActiveCharacter {
  const search =
    typeof window !== 'undefined' ? window.location.search : ''
  const id = new URLSearchParams(search).get('character')
  return id === SHIJU_CHARACTER.id ? { ...SHIJU_CHARACTER } : { ...DEFAULT_CHARACTER }
}

export function loadActiveCharacter(): Promise<ActiveCharacter> {
  if (!inTauri()) return Promise.resolve(previewCharacter())
  return invoke<ActiveCharacter>('pet_character_current')
}

export function loadPacksView(): Promise<PacksView> {
  return invoke<PacksView>('pet_packs_list')
}

/** 把后端运行时包编译成只属于该角色的动画库。 */
export function createPackLibrary(runtime: PackRuntime): AnimLibrary {
  const base = runtime.assetBase.endsWith('/') ? runtime.assetBase : `${runtime.assetBase}/`
  const entries = runtime.tracks.map((track) => ({
    id: track.id,
    displayName: track.displayName,
    path: track.path,
    tags: track.tags,
  }))
  const tracks = runtime.tracks.map((track) => {
    const trackUrl = new URL(track.path, base)
    return normalizeTrack(
      {
        id: track.id,
        displayName: track.displayName,
        path: track.path,
        tags: track.tags,
      },
      {
        ...track.struct,
        id: track.id,
        displayName: track.displayName ?? track.struct.displayName,
      },
      trackUrl,
    )
  })
  return createLibrary(
    {
      version: 'pack',
      defaultTrack: entries[0]?.id,
      tracks: entries,
    },
    tracks,
    runtime.character.id,
  )
}

export async function loadCharacterAssets(character: ActiveCharacter): Promise<CharacterAssets> {
  const renderer = rendererOf(character)
  if (character.builtin) {
    if (renderer === 'svg') {
      // 灵泡由 SvgSprite 画，不读位图轨，也不参与 ?track= 预览。
      return {
        character: { ...character, renderer },
        renderer,
        library: null,
        beats: [breathBeatOption()],
      }
    }
    const library = await loadAnimLibrary()
    return {
      character: { ...character, renderer },
      renderer,
      library,
      beats: builtinBeatOptions((track) => Boolean(library.byTag(track))),
    }
  }
  const runtime = await invoke<PackRuntime>('pet_pack_load', { packId: character.id })
  const library = createPackLibrary(runtime)
  return {
    character: runtime.character,
    renderer: 'webp',
    library,
    beats: packBeatOptions(runtime.idleBeats, (track) => Boolean(library.byTag(track))),
  }
}

export function formatInstalledAt(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  try {
    return new Date(seconds * 1000).toLocaleDateString('zh-CN')
  } catch {
    return ''
  }
}

export const packTrustNote =
  '资源包只包含 WebP/PNG 图片与 JSON，器灵不会执行其中的任何代码。请只安装来源可信的资源包。'

export function packErrorMessage(reason: unknown): string {
  const code = String(reason)
  const separator = code.indexOf(':')
  const base = separator >= 0 ? code.slice(0, separator) : code
  const detail = separator >= 0 ? code.slice(separator + 1) : ''
  const messages: Record<string, string> = {
    pack_path_invalid: '资源包里有非法路径（不允许绝对路径、..、反斜杠或非 ASCII 文件名）。',
    pack_zip_invalid: '这个文件不是有效的 .qilingpet/ZIP 资源包。',
    pack_extract_failed: '解压资源包失败，请确认文件没有损坏。',
    pack_entry_unsupported: '资源包包含不支持的文件类型或目录结构。',
    pack_too_large: '资源包超过大小限制（压缩包 96 MB / 解压 256 MB / 单文件 32 MB）。',
    pack_file_unreadable: '无法读取所选文件，请检查文件是否存在、是否有访问权限。',
    pack_manifest_missing: '资源包根目录缺少 pet.json。',
    pack_manifest_invalid: 'pet.json 字段不合法，请对照制作文档检查。',
    pack_schema_unsupported: '资源包版本高于当前器灵支持的 schemaVersion 1。',
    pack_id_invalid: '资源包 id 不合法，或与内置角色 lingpao / shiju 冲突。',
    pack_id_reserved: '资源包 id 与内置角色冲突。',
    pack_track_invalid: '动画轨 track_struct.json 不合法，或缺少运行时需要的 idle 动画图。',
    pack_asset_missing: '动画轨引用的图片不存在或路径越出资源包。',
    pack_pickup_invalid: 'pickup 声明为 animated 时，必须提供 lift/hover/drop 三段逐帧动画。',
    pack_idle_beats_invalid: 'idleBeats 配置不合法（动作不存在、文案为空或重复）。',
    pack_exists: '已安装同 id 的资源包；确认替换后会覆盖旧版本。',
    pack_not_found: '找不到该资源包，可能已经被卸载。',
    pack_builtin_protected: '内置角色不能卸载。',
    pack_in_use: '资源包文件正在被占用，请关闭占用它的程序或重启器灵后重试。',
    pack_busy: '另一个资源包操作正在进行，请稍后再试。',
    pack_io_failed: '资源包读写失败，请检查应用数据目录权限。',
    pack_file_missing: '找不到所选文件。',
    pack_install_failed: '安装资源包失败。',
  }
  if (base === 'pack_mvp_tracks_missing') {
    return `资源包缺少必做动画轨：${detail || 'idle、think、explain、advantage、disadvantage'}。最少的完整包需要五条基础轨；pickup 可声明为 window-only 后省略。`
  }
  return messages[base] ?? `资源包操作失败：${code}`
}
