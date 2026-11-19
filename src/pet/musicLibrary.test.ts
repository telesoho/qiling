import { describe, expect, it } from 'vitest'
import {
  extensionOf,
  formatBytes,
  isHttpUrl,
  isSupportedAudioExtension,
  mimeForTrack,
  musicErrorMessage,
  parseMusicLibraryView,
  suggestTrackName,
  trackKindLabel,
} from './musicLibrary'

const view = {
  tracks: [
    {
      id: 'a',
      kind: 'local',
      name: 'song',
      location: 'C:\\music\\song.mp3',
      addedAt: 1,
      mime: 'audio/mpeg',
      available: true,
      cached: false,
      cacheBytes: 0,
    },
    {
      id: 'b',
      kind: 'remote',
      name: 'online',
      location: 'https://example.com/online.flac',
      addedAt: 2,
      mime: null,
      available: false,
      cached: true,
      cacheBytes: 2048,
    },
  ],
  cache: { files: 1, bytes: 2048 },
  storageDir: 'C:\\data',
}

describe('曲库契约', () => {
  it('parses a library view and fills defaults for bad entries', () => {
    const parsed = parseMusicLibraryView({
      ...view,
      tracks: [...view.tracks, { id: '', kind: 'local' }, null],
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.tracks).toHaveLength(2)
    expect(parsed?.tracks[0].mime).toBe('audio/mpeg')
    expect(parsed?.tracks[1].cached).toBe(true)
    expect(parsed?.cache.bytes).toBe(2048)
    expect(parsed?.storageDir).toBe('C:\\data')
  })

  it('rejects payloads that are not a library at all', () => {
    expect(parseMusicLibraryView(null)).toBeNull()
    expect(parseMusicLibraryView({})).toBeNull()
    expect(parseMusicLibraryView({ tracks: 'nope' })).toBeNull()
  })

  it('accepts http(s) direct links only', () => {
    expect(isHttpUrl('https://example.com/a.mp3')).toBe(true)
    expect(isHttpUrl(' http://example.com/a.mp3 ')).toBe(true)
    expect(isHttpUrl('file:///C:/a.mp3')).toBe(false)
    expect(isHttpUrl('ftp://example.com/a.mp3')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('https://')).toBe(false)
  })

  it('suggests a display name from the URL', () => {
    expect(suggestTrackName('https://example.com/audio/hello.mp3?token=1')).toBe('hello')
    expect(suggestTrackName('https://example.com/')).toBe('example.com')
    expect(suggestTrackName('not a url')).toBe('')
  })

  it('maps extensions to MIME types', () => {
    expect(extensionOf('C:\\a\\b.MP3')).toBe('mp3')
    expect(extensionOf('https://x/y.ogg?token=1')).toBe('ogg')
    expect(extensionOf('no-extension')).toBe('')
    expect(isSupportedAudioExtension('flac')).toBe(true)
    expect(isSupportedAudioExtension('jpg')).toBe(false)
    expect(mimeForTrack({ name: 'a', location: 'https://x/a.flac', mime: null })).toBe('audio/flac')
    expect(
      mimeForTrack({ name: 'a', location: 'https://x/a', mime: 'audio/mp4' }),
    ).toBe('audio/mp4')
    expect(mimeForTrack({ name: 'a', location: 'https://x/a.bin', mime: null })).toBe('')
  })

  it('formats cache sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('labels track kinds', () => {
    expect(trackKindLabel('local')).toBe('本地')
    expect(trackKindLabel('remote')).toBe('网络')
  })

  it('turns backend codes into readable Chinese', () => {
    expect(musicErrorMessage('music_library_empty')).toContain('曲库')
    expect(musicErrorMessage('music_download_timeout')).toContain('超时')
    expect(musicErrorMessage('music_something_new')).toContain('music_something_new')
  })
})