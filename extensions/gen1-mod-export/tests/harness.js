/*
 * Headless harness for the gen1-mod-export extension.
 *
 *     node extensions/gen1-mod-export/tests/harness.js <workspace> [outDir]
 *
 * where <workspace> is a directory built by the port's tools/tiled_export.py
 * (it is the one holding vanilla.json).
 *
 * Tiled's scripting API is Qt's, so the extension cannot be unit tested by
 * loading it into a browser or a bundler.  This stubs the handful of globals it
 * actually uses -- tiled, TextFile, File, FileInfo -- and builds map objects
 * that quack like EditableMap out of the generated .tmj files.  That is enough
 * to drive the real export code and check what Lua it produces.
 *
 * The stubs mirror the real API deliberately narrowly: every property and
 * method here was read off src/tiled/editablemap.h, editabletilelayer.h,
 * editableobjectgroup.h, editablemapobject.h, editabletileset.h,
 * scriptfile.cpp and scriptfileinfo.cpp, so a passing harness means the
 * extension is calling the API Tiled really exposes.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const workspace = process.argv[2]
const outDir = process.argv[3] || null

if (!workspace || !fs.existsSync(path.join(workspace, 'vanilla.json'))) {
    console.error('usage: node harness.js <workspace-with-vanilla.json> [outDir]')
    process.exit(2)
}

// ----------------------------------------------------------------- API stubs

const logged = { warn: [], error: [], log: [], alert: [] }

class TextFile {
    constructor(filePath, mode) {
        this.filePath = filePath
        this.mode = mode
        this.buffer = ''
        if (mode === TextFile.ReadOnly) {
            this.contents = fs.readFileSync(filePath, 'utf8')
        }
    }
    readAll() { return this.contents }
    write(text) { this.buffer += text }
    commit() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        fs.writeFileSync(this.filePath, this.buffer)
    }
    close() {}
}
TextFile.ReadOnly = 1
TextFile.WriteOnly = 2

const File = {
    exists: (p) => fs.existsSync(p),
    makePath: (p) => { fs.mkdirSync(p, { recursive: true }); return true },
    copy: (from, to) => { fs.copyFileSync(from, to); return true }
}

const FileInfo = {
    path: (p) => path.dirname(p),
    fileName: (p) => path.basename(p),
    baseName: (p) => path.basename(p, path.extname(p)),
    joinPaths: (...parts) => path.join(...parts),
    relativePath: (dir, p) => path.relative(dir, p)
}

const tiled = {
    projectFilePath: path.join(workspace, 'gen1.tiled-project'),
    openAssets: [],
    version: '1.12.2',
    log: (t) => logged.log.push(t),
    warn: (t) => logged.warn.push(t),
    error: (t) => logged.error.push(t),
    alert: (t) => logged.alert.push(t),
    registerMapFormat: (shortName, format) => { tiled.formats[shortName] = format },
    registerAction: (id, callback) => {
        const action = { id, callback, text: '' }
        tiled.actions[id] = action
        return action
    },
    extendMenu: () => {},
    promptDirectory: () => outDir,
    formats: {},
    actions: {}
}

// --------------------------------------------- .tmj -> EditableMap-alike

/*
 * The live API does NOT hand back what the .tmj stores for a typed property.
 * On disk the value is bare; through EditableObject.property it arrives wrapped
 * as { value, typeId, typeName } -- and for an ENUM the wrapped value is the
 * INDEX into the type's values, not the name.
 *
 * The harness reproduces both wrappers, because a stub that returned bare
 * values quietly passes code that breaks in Tiled. That is not hypothetical:
 * it is how the connection reader and the enum reader both shipped broken.
 */
const projectEnums = (() => {
    const file = path.join(workspace, 'gen1.tiled-project')
    if (!fs.existsSync(file)) return {}
    const project = JSON.parse(fs.readFileSync(file, 'utf8'))
    const byName = {}
    for (const type of project.propertyTypes || []) {
        if (type.type === 'enum') byName[type.name] = type.values
    }
    return byName
})()

function propertyBag(properties) {
    const bag = {}
    for (const entry of properties || []) {
        const enumValues = entry.propertytype
            ? projectEnums[entry.propertytype]
            : null
        if (enumValues) {
            const index = enumValues.indexOf(entry.value)
            bag[entry.name] = {
                value: index === -1 ? entry.value : index,
                typeId: 7, typeName: entry.propertytype
            }
        } else if (entry.type === 'class') {
            bag[entry.name] = {
                value: entry.value, typeId: 8, typeName: entry.propertytype
            }
        } else {
            bag[entry.name] = entry.value
        }
    }
    return bag
}

/* An EditableTileset stand-in over a .tsj on disk. */
function loadTileset(tsjPath) {
    const raw = JSON.parse(fs.readFileSync(tsjPath, 'utf8'))
    const byId = new Map()
    for (const tile of raw.tiles || []) {
        const bag = propertyBag(tile.properties)
        byId.set(tile.id, {
            id: tile.id,
            className: tile.type || '',
            property: (name) => bag[name],
            resolvedProperty: (name) => bag[name]
        })
    }
    const tiles = []
    for (let id = 0; id < raw.tilecount; id++) {
        if (!byId.has(id)) {
            byId.set(id, {
                id,
                className: '',
                property: () => undefined,
                resolvedProperty: () => undefined
            })
        }
        tiles.push(byId.get(id))
    }
    // tileset-level properties, e.g. gen1Tileset / gen1Palette on an atlas
    const tilesetBag = propertyBag(raw.properties)
    return {
        name: raw.name,
        className: raw.class || '',
        property: (name) => tilesetBag[name],
        resolvedProperty: (name) => tilesetBag[name],
        imageFileName: path.resolve(path.dirname(tsjPath), raw.image),
        imageWidth: raw.imagewidth,
        imageHeight: raw.imageheight,
        columnCount: raw.columns,
        tileCount: raw.tilecount,
        tileWidth: raw.tilewidth,
        tileHeight: raw.tileheight,
        tiles,
        tile: (id) => byId.get(id)
    }
}

function loadMap(tmjPath) {
    const raw = JSON.parse(fs.readFileSync(tmjPath, 'utf8'))
    const bag = propertyBag(raw.properties)

    const tilesets = (raw.tilesets || []).map((entry) => ({
        firstgid: entry.firstgid,
        tileset: loadTileset(path.resolve(path.dirname(tmjPath), entry.source))
    }))

    function tilesetForGid(gid) {
        let chosen = null
        for (const entry of tilesets) {
            if (gid >= entry.firstgid) chosen = entry
        }
        return chosen
    }

    const layers = (raw.layers || []).map((layer) => {
        if (layer.type === 'tilelayer') {
            return {
                name: layer.name,
                isTileLayer: true,
                isObjectLayer: false,
                width: layer.width,
                height: layer.height,
                tileAt(x, y) {
                    const gid = layer.data[y * layer.width + x]
                    if (!gid) return null
                    const entry = tilesetForGid(gid)
                    if (!entry) return null
                    return entry.tileset.tile(gid - entry.firstgid)
                }
            }
        }
        return {
            name: layer.name,
            isTileLayer: false,
            isObjectLayer: true,
            objects: (layer.objects || []).map((object) => {
                const objectBag = propertyBag(object.properties)
                return {
                    id: object.id,
                    name: object.name,
                    className: object.type || '',
                    x: object.x,
                    y: object.y,
                    width: object.width,
                    height: object.height,
                    property: (name) => objectBag[name],
                    resolvedProperty: (name) => objectBag[name]
                }
            })
        }
    })

    return {
        fileName: tmjPath,
        isTileMap: true,
        isTileset: false,
        className: raw.class || '',
        width: raw.width,
        height: raw.height,
        tileWidth: raw.tilewidth,
        tileHeight: raw.tileheight,
        infinite: !!raw.infinite,
        layerCount: layers.length,
        layerAt: (index) => layers[index],
        tilesets: tilesets.map((entry) => entry.tileset),
        property: (name) => bag[name],
        resolvedProperty: (name) => bag[name],
        properties: () => bag
    }
}

// ------------------------------------------------------------ load extension

const sandbox = {
    tiled, TextFile, File, FileInfo,
    console, JSON, Math, Object, Array, String, Number, Boolean, Error,
    RegExp, Date, isNaN, parseInt, parseFloat, undefined
}
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)

const extensionDir = path.resolve(__dirname, '..')
for (const file of fs.readdirSync(extensionDir).filter((f) => f.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(extensionDir, file), 'utf8')
    vm.runInContext(source, context, { filename: file })
}

module.exports = {
    workspace, outDir, tiled, logged, loadMap, loadTileset,
    Gen1: sandbox.Gen1,
    mapPath: (mapId) => path.join(workspace, 'maps', `${mapId}.tmj`),
    blocksetPath: (tilesetId) => path.join(workspace, 'blocksets', `${tilesetId}.tmj`)
}
