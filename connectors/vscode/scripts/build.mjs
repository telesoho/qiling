import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sdkRoot = resolve(here, '..', '..', '..', 'sdk', 'typescript')
const sdkDist = resolve(sdkRoot, 'dist')
const bundledSdk = resolve(here, '..', 'lib', 'spirit-client')

await rm(bundledSdk, { recursive: true, force: true })
await mkdir(bundledSdk, { recursive: true })
await cp(sdkDist, resolve(bundledSdk, 'dist'), { recursive: true })
await cp(resolve(sdkRoot, 'package.json'), resolve(bundledSdk, 'package.json'))
console.log('Bundled @qiling/spirit-client into the VS Code extension.')
