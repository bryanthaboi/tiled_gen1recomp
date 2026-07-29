/*
 * Tests for the gen1-mod-export extension, driven through tests/harness.js.
 *
 *     node extensions/gen1-mod-export/tests/run.js <workspace> [outDir]
 *
 * <workspace> is a directory built by the port's tools/tiled_export.py.  The
 * tests read the real generated maps, so what passes here is what the extension
 * will do to the player's own imported data.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const harness = require('./harness.js')
const { Gen1, tiled, logged, loadMap } = harness

let passed = 0
const failures = []

function check(condition, what) {
    if (condition) {
        passed++
    } else {
        failures.push(what)
    }
}

function checkEqual(got, want, what) {
    const same = JSON.stringify(got) === JSON.stringify(want)
    if (!same) {
        failures.push(`${what}\n     got: ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
    } else {
        passed++
    }
}

// Through Gen1.loadBaseline rather than a bare readFileSync, so the tests
// follow the same contract the exporters do: loading the baseline is also what
// arms enum index -> name resolution.
const vanilla = Gen1.loadBaseline(harness.mapPath('PALLET_TOWN'))
check(!!vanilla.propertyEnums,
    'the baseline carries the project enum value lists')

// ------------------------------------------------------ the extension loaded

check(typeof Gen1 === 'object', 'gen1-core.js defines Gen1')
check(!!tiled.formats.gen1mod, 'the map format registered')
check(tiled.formats.gen1mod.extension === 'lua', 'the format writes .lua')
check(!!tiled.actions.Gen1ExportMod, 'the Export Gen1 Mod action registered')

// -------------------------------------------- every vanilla map reads clean

const mapIds = Object.keys(vanilla.maps).sort()
let readFailures = 0
let diffFailures = 0
const diffDetail = []

for (const mapId of mapIds) {
    let read
    try {
        read = Gen1.readMap(loadMap(harness.mapPath(mapId)))
    } catch (error) {
        readFailures++
        diffDetail.push(`${mapId}: read threw ${error.message}`)
        continue
    }

    if (read.mapId !== mapId) {
        readFailures++
        diffDetail.push(`${mapId}: read back as ${read.mapId}`)
        continue
    }
    if (read.warnings.length > 0) {
        readFailures++
        diffDetail.push(`${mapId}: warned ${read.warnings.join('; ')}`)
        continue
    }

    // An untouched vanilla map must diff to nothing.  This is the load-bearing
    // property of the whole pipeline: it proves the generator and the exporter
    // agree on the model, so a patch only ever carries a real edit.
    const diff = Gen1.diffMap(read, vanilla)
    if (diff.verb !== 'patch' || Object.keys(diff.fields).length !== 0) {
        diffFailures++
        if (diffDetail.length < 12) {
            diffDetail.push(`${mapId}: ${diff.verb} ${JSON.stringify(Object.keys(diff.fields))}`)
        }
    }
}

check(readFailures === 0, `all ${mapIds.length} maps read clean (${readFailures} failed)`)
check(diffFailures === 0,
    `all ${mapIds.length} untouched maps diff to an empty patch (${diffFailures} differed)`)
if (diffDetail.length > 0) {
    failures.push('detail:\n    ' + diffDetail.join('\n    '))
}

// --------------------------------------- every blockset round trips its blocks

const tilesetIds = Object.keys(vanilla.tilesets).sort()
let blocksetFailures = 0
for (const tilesetId of tilesetIds) {
    let read
    try {
        read = Gen1.readBlockset(loadMap(harness.blocksetPath(tilesetId)))
    } catch (error) {
        blocksetFailures++
        failures.push(`${tilesetId}: blockset read threw ${error.message}`)
        continue
    }
    const base = vanilla.tilesets[tilesetId]
    if (JSON.stringify(read.blocks) !== JSON.stringify(base.blocks)) {
        blocksetFailures++
        failures.push(`${tilesetId}: blocks did not round trip ` +
            `(${read.blocks.length} vs ${base.blocks.length} blocks)`)
    }
}
check(blocksetFailures === 0,
    `all ${tilesetIds.length} blocksets round trip their blocks`)

// ------------------------------------- an unchanged tileset diffs to nothing

let tilesetDiffFailures = 0
for (const tilesetId of tilesetIds) {
    const map = loadMap(harness.blocksetPath(tilesetId))
    const read = Gen1.readBlockset(map)
    const tileset = map.tilesets[0]
    const sheet = Gen1.readSheet(tileset, tilesetId, harness.workspace, vanilla)
    const flags = Gen1.readTileFlags(tileset)
    flags.image = sheet.image
    flags.imageWidth = sheet.imageWidth
    flags.imageHeight = sheet.imageHeight
    flags.tilesPerRow = sheet.tilesPerRow

    const diff = Gen1.diffTileset(read, flags, vanilla)
    if (diff.verb !== 'patch' || Object.keys(diff.fields).length !== 0) {
        tilesetDiffFailures++
        failures.push(`${tilesetId}: unchanged tileset diffed as ${diff.verb} ` +
            JSON.stringify(Object.keys(diff.fields)))
    }
    // a vanilla sheet must never be copied into a mod
    if (sheet.copyFrom !== null) {
        failures.push(`${tilesetId}: would copy the imported sheet into the mod`)
    } else {
        passed++
    }
}
check(tilesetDiffFailures === 0,
    `all ${tilesetIds.length} untouched tilesets diff to an empty patch`)

// -------------------------------------------------- an edit produces a patch

const pallet = loadMap(harness.mapPath('PALLET_TOWN'))
const palletBase = vanilla.maps.PALLET_TOWN

// repaint one block, move one warp, drop a connection, add an NPC
const editedBlocks = palletBase.blocks.slice()
editedBlocks[0] = editedBlocks[0] === 1 ? 2 : 1

const edited = Object.assign({}, pallet, {
    layerAt(index) {
        const layer = pallet.layerAt(index)
        if (layer.isTileLayer) {
            return Object.assign({}, layer, {
                tileAt(x, y) {
                    const wanted = editedBlocks[y * pallet.width + x]
                    return { id: wanted, tileset: { name: 'blocks_OVERWORLD' } }
                }
            })
        }
        return layer
    },
    property(name) {
        if (name === 'connectNorth') return undefined  // drop the north link
        return pallet.property(name)
    },
    resolvedProperty(name) {
        if (name === 'connectNorth') return undefined
        return pallet.resolvedProperty(name)
    }
})

const editedRead = Gen1.readMap(edited)
const editedDiff = Gen1.diffMap(editedRead, vanilla)

check(editedDiff.verb === 'patch', 'an edited vanilla map patches')
const editedFields = Object.keys(editedDiff.fields).sort()
checkEqual(editedFields, ['blocks', 'connections', 'height', 'width'],
    'the patch carries exactly the changed fields plus geometry')
check(editedDiff.fields.connections.north === Gen1.DELETE,
    'a dropped connection becomes mod.DELETE, not a silent no-op')
check(editedDiff.fields.blocks[0] === editedBlocks[0],
    'the repainted block is in the patch')

const patchLua = Gen1.mapChunk(editedRead, editedDiff, '  ')
check(patchLua.indexOf('mod.content.maps:patch("PALLET_TOWN"') !== -1,
    'the emitted chunk patches by map id')
check(patchLua.indexOf('north = mod.DELETE') !== -1,
    'the emitted chunk unsets the dropped connection')
check(patchLua.indexOf('warps') === -1,
    'the emitted chunk leaves untouched fields out entirely')

// ------------------------------------------------- a brand new map registers

const authored = Object.assign({}, pallet, {
    fileName: path.join(harness.workspace, 'maps', 'MY_COVE.tmj'),
    property(name) {
        if (name === 'mapId') return 'MY_COVE'
        if (name === 'label') return 'MyCove'
        if (name === 'vanilla') return false
        if (name === 'index') return undefined
        return pallet.property(name)
    },
    resolvedProperty(name) { return this.property(name) }
})

const authoredRead = Gen1.readMap(authored)
const authoredDiff = Gen1.diffMap(authoredRead, vanilla)
check(authoredDiff.verb === 'register', 'a non-vanilla map registers')
check(authoredDiff.fields.index >= 1000,
    `a new map takes an index at or above 1000 (got ${authoredDiff.fields.index})`)
const registerLua = Gen1.mapChunk(authoredRead, authoredDiff, '  ')
check(registerLua.indexOf('mod.content.maps:register("MY_COVE"') !== -1,
    'the emitted chunk registers by map id')
check(registerLua.indexOf('blocks = {') !== -1,
    'a registered map carries its whole blocks array')

// ---------------------------------------------------------------- exact mode

function withProperties(base, overrides) {
    return Object.assign({}, base, {
        property(name) {
            return Object.prototype.hasOwnProperty.call(overrides, name)
                ? overrides[name]
                : base.property(name)
        },
        resolvedProperty(name) { return this.property(name) }
    })
}

// an UNTOUCHED vanilla map in exact mode still exports, where auto skips it
const exactPallet = withProperties(pallet, { exactExport: true })
const exactRead = Gen1.readMap(exactPallet)
const exactDiff = Gen1.diffMap(exactRead, vanilla)

check(exactDiff.verb === 'override',
    `exact mode on a base game map overrides (got ${exactDiff.verb})`)
checkEqual(Object.keys(exactDiff.fields).sort(),
    ['blocks', 'borderBlock', 'connections', 'height', 'index', 'label',
     'objects', 'palette', 'signs', 'tileset', 'warps', 'width'],
    'an override carries the whole record, palette included')
check(exactDiff.fields.index === palletBase.index,
    `an override keeps index (got ${exactDiff.fields.index}, want ${palletBase.index})`)
check(Gen1.deepEqual(exactDiff.fields.blocks, palletBase.blocks),
    'an override reproduces the untouched blocks exactly')
check(Gen1.deepEqual(exactDiff.fields.warps, palletBase.warps),
    'an override reproduces the untouched warps exactly')
check(Gen1.deepEqual(exactDiff.fields.objects, palletBase.objects),
    'an override reproduces the untouched objects exactly')
check(exactDiff.warnings.length > 0,
    'exact mode says out loud that it wins over other mods')

const exactLua = Gen1.mapChunk(exactRead, exactDiff, '  ')
check(exactLua.indexOf('mod.content.maps:override("PALLET_TOWN"') !== -1,
    'the emitted chunk uses the override verb')
check(exactLua.indexOf('id = "PALLET_TOWN"') !== -1,
    'an override carries the record id')

// exact mode on a NEW map is still a register -- register already means whole
const exactNew = withProperties(pallet, {
    mapId: 'MY_EXACT_COVE', vanilla: false, index: undefined, exactExport: true
})
const exactNewDiff = Gen1.diffMap(Gen1.readMap(exactNew), vanilla)
check(exactNewDiff.verb === 'register',
    `exact mode on a new map still registers (got ${exactNewDiff.verb})`)

// ------------------------------- the verb follows the id, not the vanilla flag

// A base game map mislabelled vanilla:false must NOT become a register --
// Registry:register errors outright on an existing id, so that would be a hard
// load failure rather than a mod.
const mislabelled = withProperties(pallet, { vanilla: false })
const mislabelledDiff = Gen1.diffMap(Gen1.readMap(mislabelled), vanilla)
check(mislabelledDiff.verb === 'patch',
    `a base game map marked not-vanilla still patches (got ${mislabelledDiff.verb})`)
check(mislabelledDiff.warnings.some((w) => w.indexOf('base game map') !== -1),
    'the mislabelled map is called out')

// ...and the reverse: an unknown id marked vanilla:true registers
const phantom = withProperties(pallet, { mapId: 'NOT_A_REAL_MAP', vanilla: true })
const phantomDiff = Gen1.diffMap(Gen1.readMap(phantom), vanilla)
check(phantomDiff.verb === 'register',
    `an unknown id marked vanilla registers (got ${phantomDiff.verb})`)
check(phantomDiff.warnings.some((w) => w.indexOf('not a base game') !== -1),
    'the phantom vanilla map is called out')

// -------------------------------------------------------------- palettes

check(!!vanilla.paletteByMap, 'the baseline records what each map renders with')
check(vanilla.paletteByMap.PALLET_TOWN === 'PALLET',
    `Pallet Town resolves to PALLET (got ${vanilla.paletteByMap.PALLET_TOWN})`)
check(vanilla.paletteByMap.REDS_HOUSE_1F === 'PALLET',
    'an interior inherits the town it is reached from')
check(vanilla.paletteByMap.ROUTE_1 === 'ROUTE', 'routes resolve by prefix')
check(vanilla.paletteByMap.MT_MOON_B2F === 'CAVE', 'caves resolve by tileset')

// an untouched map already diffs to empty (checked above over all 222), so the
// palette it carries must NOT show up as a change
const palRead = Gen1.readMap(loadMap(harness.mapPath('PALLET_TOWN')))
check(palRead.record.palette === 'PALLET',
    `the map carries its resolved palette (got ${palRead.record.palette})`)
check(!('palette' in Gen1.diffMap(palRead, vanilla).fields),
    'the unchanged palette is not exported')

// recolouring a map exports a palette on the record, which beats the cascade
const recoloured = Gen1.readMap(withProperties(pallet, { palette: 'CINNABAR' }))
const recolourDiff = Gen1.diffMap(recoloured, vanilla)
checkEqual(Object.keys(recolourDiff.fields), ['palette'],
    'recolouring exports only the palette')
check(Gen1.mapChunk(recoloured, recolourDiff, '  ')
        .indexOf('palette = "CINNABAR"') !== -1,
    'the emitted chunk names the palette')

// blocks pasted between maps on different palettes still resolve to one tileset
const pallettPal = harness.loadTileset(
    path.join(harness.workspace, 'tilesets', 'blocks_OVERWORLD__PALLET.tsj'))
const viridianPal = harness.loadTileset(
    path.join(harness.workspace, 'tilesets', 'blocks_OVERWORLD__VIRIDIAN.tsj'))
check(pallettPal.property('gen1Tileset') === 'OVERWORLD' &&
      viridianPal.property('gen1Tileset') === 'OVERWORLD',
    'both palette variants declare the same gen1 tileset')

const mixed = Object.assign({}, pallet, {
    layerAt(index) {
        const layer = pallet.layerAt(index)
        if (!layer.isTileLayer) return layer
        return Object.assign({}, layer, {
            // alternate the two variants, as copy/paste between maps would
            tileAt: (x, y) => ({
                id: palletBase.blocks[y * pallet.width + x],
                tileset: ((x + y) % 2 === 0) ? pallettPal : viridianPal
            })
        })
    }
})
let mixedOk = true
try {
    const mixedRead = Gen1.readMap(mixed)
    mixedOk = Gen1.deepEqual(mixedRead.record.blocks, palletBase.blocks)
} catch (error) {
    mixedOk = false
    failures.push('mixing palette variants threw: ' + error.message)
}
check(mixedOk, 'blocks pasted across palette variants read back unchanged')

// ------------------------------------ enum-typed properties resolve to names

// Tiled reports an enum property as its index into the type's values.  An
// object whose sprite was picked from the SpriteId dropdown (rather than typed)
// arrives that way, and must still export as the NAME.
const spriteEnum = JSON.parse(fs.readFileSync(
    path.join(harness.workspace, 'gen1.tiled-project'), 'utf8'))
    .propertyTypes.find((t) => t.name === 'SpriteId').values

const oaksLab = harness.loadMap(harness.mapPath('OAKS_LAB'))
const dropdownPicked = Object.assign({}, oaksLab, {
    layerAt(index) {
        const layer = oaksLab.layerAt(index)
        if (!layer.isObjectLayer || layer.name !== 'objects') return layer
        return Object.assign({}, layer, {
            objects: layer.objects.map(function (object, position) {
                if (position !== 0) return object
                // exactly what the dropdown stores: the envelope + the index
                const wrapped = {
                    value: spriteEnum.indexOf('SPRITE_OAK'),
                    typeId: 7, typeName: 'SpriteId'
                }
                return Object.assign({}, object, {
                    property: (name) => name === 'sprite'
                        ? wrapped : object.property(name),
                    resolvedProperty: (name) => name === 'sprite'
                        ? wrapped : object.resolvedProperty(name)
                })
            })
        })
    }
})

const dropdownRead = Gen1.readMap(dropdownPicked)
const firstSprite = dropdownRead.record.objects.find(
    (o) => o.index === 1).sprite
check(firstSprite === 'SPRITE_OAK',
    `an enum index resolves to its name (got ${JSON.stringify(firstSprite)})`)
check(typeof firstSprite === 'string',
    'a dropdown-picked sprite never exports as a number')

// and every vanilla object already round trips through the wrapped path
let enumLeaks = 0
for (const mapId of mapIds) {
    for (const obj of Gen1.readMap(loadMap(harness.mapPath(mapId))).record.objects) {
        for (const key of ['sprite', 'movement', 'range', 'trainerClass']) {
            if (key in obj && typeof obj[key] !== 'string') enumLeaks++
        }
    }
}
check(enumLeaks === 0, `no object field leaked a non-string (${enumLeaks} did)`)

// ------------------------------------------------- reciprocal connections

// Every vanilla pair satisfies back.offset == -offset, so a new map hung off
// Kanto has a derivable return connection. Without it you walk in and are stuck.
const hangsOffRoute21 = withProperties(pallet, {
    mapId: 'SABLE_COVE', vanilla: false, index: undefined,
    connectNorth: { map: 'ROUTE_21', offset: 3 },
    connectSouth: undefined, connectEast: undefined, connectWest: undefined
})
const coveRead = Gen1.readMap(hangsOffRoute21)
const backLinks = Gen1.reciprocalConnections([coveRead], vanilla)

check(!!backLinks.ROUTE_21, 'a new map hung off Route 21 patches Route 21 back')
if (backLinks.ROUTE_21) {
    checkEqual(backLinks.ROUTE_21.south, { map: 'SABLE_COVE', offset: -3 },
        'the return connection is the opposite direction with a negated offset')
}
const backLua = Gen1.reciprocalChunk('ROUTE_21', backLinks.ROUTE_21, '  ')
check(backLua.indexOf('mod.content.maps:patch("ROUTE_21"') !== -1,
    'the return connection is emitted as a patch on the base map')
check(backLua.indexOf('south = { map = "SABLE_COVE", offset = -3 }') !== -1,
    'the emitted return connection names the authored map')

// a connection between two maps the export already owns needs no help --
// both sides must be authored, connections included, or the other side's own
// links legitimately generate patches of their own
const ownedRoute21 = Gen1.readMap(withProperties(pallet, {
    mapId: 'ROUTE_21', vanilla: false, index: undefined,
    connectSouth: { map: 'SABLE_COVE', offset: -3 },
    connectNorth: undefined, connectEast: undefined, connectWest: undefined
}))
const twoOwned = Gen1.reciprocalConnections([coveRead, ownedRoute21], vanilla)
checkEqual(Object.keys(twoOwned), [],
    'no return patch when the export owns both sides')

// an untouched vanilla map must not generate busywork patches
const untouchedBack = Gen1.reciprocalConnections(
    [Gen1.readMap(loadMap(harness.mapPath('ROUTE_1')))], vanilla)
check(Object.keys(untouchedBack).length === 0,
    'an untouched vanilla map needs no return patches')

// -------------------------------------------------- the single-map export path

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-export-'))
const singleFile = path.join(scratch, 'PALLET_TOWN.lua')
const writeResult = tiled.formats.gen1mod.write(edited, singleFile)
check(writeResult === undefined, `the map format wrote without error (${writeResult})`)
check(fs.existsSync(singleFile), 'the map format produced a file')
const singleBody = fs.existsSync(singleFile) ? fs.readFileSync(singleFile, 'utf8') : ''
check(singleBody.indexOf('return function(mod)') !== -1,
    'the exported map file returns function(mod)')

// ------------------------------------------------------ the full mod export

if (harness.outDir) {
    tiled.openAssets = [edited, authored]
    tiled.actions.Gen1ExportMod.callback()

    const wrote = (relative) => fs.existsSync(path.join(harness.outDir, relative))
    check(wrote('manifest.json'), 'the mod export wrote manifest.json')
    check(wrote('main.lua'), 'the mod export wrote main.lua')
    check(wrote('maps/PALLET_TOWN.lua'), 'the mod export wrote the patched map')
    check(wrote('maps/MY_COVE.lua'), 'the mod export wrote the registered map')
    check(wrote('README.md'), 'the mod export wrote a README')

    if (wrote('manifest.json')) {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(harness.outDir, 'manifest.json'), 'utf8'))
        check(manifest.entry === 'main.lua', 'the manifest names main.lua as entry')
        check(manifest.api === vanilla.modApi,
            `the manifest declares api ${vanilla.modApi}`)
        check(manifest.game_version === vanilla.gameVersion,
            'the manifest declares the engine range from Version.lua')
        check(/^[a-z0-9_]+$/.test(manifest.id),
            `the manifest id is engine-legal (${manifest.id})`)
    }

    // two new maps in one export must not collide on an index
    tiled.openAssets = [authored, Object.assign({}, authored, {
        fileName: path.join(harness.workspace, 'maps', 'MY_CAVE.tmj'),
        property(name) {
            if (name === 'mapId') return 'MY_CAVE'
            return authored.property(name)
        },
        resolvedProperty(name) { return this.property(name) }
    })]
    tiled.actions.Gen1ExportMod.callback()
    const cave = path.join(harness.outDir, 'maps', 'MY_CAVE.lua')
    const cove = path.join(harness.outDir, 'maps', 'MY_COVE.lua')
    if (fs.existsSync(cave) && fs.existsSync(cove)) {
        const indexOf = (file) => {
            const match = fs.readFileSync(file, 'utf8').match(/index = (\d+)/)
            return match ? Number(match[1]) : null
        }
        check(indexOf(cave) !== indexOf(cove),
            `two new maps get distinct indices (${indexOf(cove)} vs ${indexOf(cave)})`)
    } else {
        failures.push('both new maps should have been written')
    }
}

// ------------------------------------------------------------------- report

console.log(`\ngen1-mod-export: ${passed} check(s) passed, ${failures.length} failed`)
if (logged.warn.length > 0) {
    console.log(`\n${logged.warn.length} warning(s) from the extension:`)
    logged.warn.slice(0, 10).forEach((w) => console.log('  ' + w))
}
if (logged.error.length > 0) {
    console.log(`\n${logged.error.length} error(s) from the extension:`)
    logged.error.slice(0, 10).forEach((e) => console.log('  ' + e))
}
if (failures.length > 0) {
    console.log('\nFAILED:')
    failures.forEach((f) => console.log('  - ' + f))
    process.exit(1)
}
console.log('all good')
