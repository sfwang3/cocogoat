import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import categories from '../src/generated/amos-data/amos/achievements/index.js'

const versionMeta = JSON.parse(await readFile(new URL('../src/generated/versionMeta.json', import.meta.url)))
const achievements = categories.flatMap((category) => category.achievements)
const ids = achievements.map(({ id }) => id)
assert.equal(new Set(ids).size, ids.length, 'achievement IDs must be unique')
assert.deepEqual(
    ids.filter((id) => !Number.isFinite(versionMeta[id])),
    [],
    'each achievement must have a version',
)
assert.equal(ids.filter((id) => versionMeta[id] <= 7.2).length, 1909)
assert.ok(ids.filter((id) => versionMeta[id] <= 7.1).length < 1909, 'later achievements must be excluded')
console.log(`PASS: ${ids.length} achievements have unique IDs and version metadata; 1909 released by 7.2`)
