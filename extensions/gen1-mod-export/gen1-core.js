/*
 * Shared model between a Tiled map and a Pokemon Gen 1 recomp mod.
 *
 * Tiled evaluates an extension's *.js in alphabetical order against one shared
 * global object, so this file sorts first and owns every piece of knowledge
 * about the gen1 data model.  The two export scripts beside it stay thin.
 *
 * THE MODEL
 *
 * A gen1 map is `blocks`: a flat width*height array of block ids.  One block is
 * 32x32 pixels, so a Tiled tile layer at 32x32 tile size IS that array, with
 * the tileset built so tile id == block id.
 *
 * Warps, signs and objects do NOT live on the block grid.  They live on the
 * 16px CELL grid -- two cells per block edge -- which is the grid the engine
 * addresses walkability and interaction on.  So object pixel coordinates
 * divide by 16, never by 32.
 *
 * Collision is a property of the 8x8 TILE at a cell's feet, not of the block
 * (src/world/Map.lua:45).  That is why authoring a new tileset means flagging
 * tiles, and why this file reads `walkable` and friends off tile properties.
 *
 * MERGE SEMANTICS (why patch is safe here)
 *
 * The maps registry is declared `semantics = "record"` (src/mods/Schemas.lua:487).
 * Under record semantics Merge.deepMerge replaces arrays wholesale
 * (src/mods/Merge.lua:104-109) -- list APPEND is deep-registry-only -- so a
 * patch carrying `blocks` or `warps` replaces them, which is what an edited map
 * means.  `connections` is a dictionary, so it merges per direction and a
 * direction the edit dropped has to be unset with mod.DELETE explicitly.
 */

var Gen1 = (function () {
    'use strict'

    var BLOCK_PX = 32
    var CELL_PX = 16
    var TILE_PX = 8

    // ids at or above this are the range the loader reserves for mod maps; the
    // ROM's own table is byte-wide (src/mods/Schemas.lua:489)
    var MOD_MAP_INDEX_BASE = 1000

    var DIRECTIONS = ['north', 'south', 'east', 'west']

    // the flag lists a tileset record carries, paired with the per-tile
    // boolean property that authors them
    var TILE_FLAG_LISTS = [
        { property: 'walkable', field: 'walkable' },
        { property: 'water', field: 'waterTiles' },
        { property: 'shore', field: 'shoreTiles' },
        { property: 'door', field: 'doorTiles' },
        { property: 'warp', field: 'warpTiles' },
        { property: 'counter', field: 'counterTiles' },
        { property: 'animated', field: 'animatedTiles' }
    ]

    // enum type name -> its `values`, from the baseline.  Declared up here
    // because loadBaseline fills it long before unwrapClassValue reads it.
    var enumValues = {}

    var MAP_FIELD_ORDER = [
        'id', 'label', 'index', 'tileset', 'palette', 'width', 'height',
        'borderBlock', 'blocks', 'connections', 'warps', 'signs', 'objects'
    ]

    var WARP_KEYS = ['x', 'y', 'destMap', 'destWarp']
    var SIGN_KEYS = ['x', 'y', 'text']
    var OBJECT_KEYS = [
        'index', 'name', 'sprite', 'movement', 'range', 'text',
        'x', 'y', 'trainerClass', 'trainerParty', 'item', 'pokemon',
        'level', 'hidden'
    ]

    // ------------------------------------------------------------- utilities

    function isBlank(value) {
        return value === undefined || value === null || value === ''
    }

    function deepEqual(a, b) {
        if (a === b) return true
        if (typeof a !== typeof b) return false
        if (a === null || b === null) return false
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b)) return false
            if (a.length !== b.length) return false
            for (var i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i])) return false
            }
            return true
        }
        if (typeof a === 'object') {
            var keysA = Object.keys(a).filter(function (k) { return !isBlank(a[k]) })
            var keysB = Object.keys(b).filter(function (k) { return !isBlank(b[k]) })
            if (keysA.length !== keysB.length) return false
            for (var j = 0; j < keysA.length; j++) {
                var key = keysA[j]
                if (!deepEqual(a[key], b[key])) return false
            }
            return true
        }
        return false
    }

    function readJson(path) {
        var file = new TextFile(path, TextFile.ReadOnly)
        try {
            return JSON.parse(file.readAll())
        } finally {
            file.close()
        }
    }

    function writeText(path, text) {
        File.makePath(FileInfo.path(path))
        var file = new TextFile(path, TextFile.WriteOnly)
        file.write(text)
        file.commit()
    }

    // --------------------------------------------------- workspace + baseline

    var baselineCache = {}

    /* Walk up from a map file to the workspace root that holds vanilla.json. */
    function findWorkspace(startPath) {
        var dir = startPath ? FileInfo.path(startPath) : ''
        for (var hop = 0; hop < 16 && dir; hop++) {
            if (File.exists(FileInfo.joinPaths(dir, 'vanilla.json'))) return dir
            var parent = FileInfo.path(dir)
            if (!parent || parent === dir) break
            dir = parent
        }
        // fall back to the project's own directory, which is where
        // tools/tiled_export.py puts the baseline
        if (tiled.projectFilePath) {
            var projectDir = FileInfo.path(tiled.projectFilePath)
            if (File.exists(FileInfo.joinPaths(projectDir, 'vanilla.json'))) {
                return projectDir
            }
        }
        return null
    }

    function loadBaseline(startPath) {
        var workspace = findWorkspace(startPath)
        if (!workspace) {
            throw new Error(
                'cannot find vanilla.json -- open the workspace that ' +
                'tools/tiled_export.py generated, or regenerate it')
        }
        if (!baselineCache[workspace]) {
            baselineCache[workspace] =
                readJson(FileInfo.joinPaths(workspace, 'vanilla.json'))
        }
        // enum index -> name needs these before any property is read, which is
        // why every caller must load the baseline before reading a map
        enumValues = baselineCache[workspace].propertyEnums || {}
        return baselineCache[workspace]
    }

    function forgetBaseline() {
        baselineCache = {}
        enumValues = {}
    }

    // -------------------------------------------------------- Lua serializing

    function luaString(value) {
        return '"' + String(value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t') + '"'
    }

    function luaKey(key) {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : '[' + luaString(key) + ']'
    }

    /* DELETE is a sentinel the mod API exposes as mod.DELETE, not a value. */
    var DELETE = { __gen1Delete: true }

    function luaScalar(value) {
        if (value === DELETE) return 'mod.DELETE'
        if (value === true) return 'true'
        if (value === false) return 'false'
        if (typeof value === 'number') return String(value)
        return luaString(value)
    }

    /* One record on one line: { x = 4, y = 11, destMap = "X", destWarp = 3 } */
    function luaInlineRecord(record, keyOrder) {
        var parts = []
        keyOrder.forEach(function (key) {
            if (isBlank(record[key])) return
            parts.push(luaKey(key) + ' = ' + luaScalar(record[key]))
        })
        return '{ ' + parts.join(', ') + ' }'
    }

    function luaRecordList(list, keyOrder, indent) {
        if (!list || list.length === 0) return '{}'
        var lines = ['{']
        list.forEach(function (entry) {
            lines.push(indent + '  ' + luaInlineRecord(entry, keyOrder) + ',')
        })
        lines.push(indent + '}')
        return lines.join('\n')
    }

    /* Block ids laid out `width` per line, so the array reads as the map. */
    function luaBlocks(blocks, width, indent) {
        if (!blocks || blocks.length === 0) return '{}'
        var lines = ['{']
        var pad = 0
        blocks.forEach(function (id) {
            pad = Math.max(pad, String(id).length)
        })
        for (var offset = 0; offset < blocks.length; offset += width) {
            var row = blocks.slice(offset, offset + width).map(function (id) {
                var text = String(id)
                while (text.length < pad) text = ' ' + text
                return text
            })
            lines.push(indent + '  ' + row.join(', ') + ',')
        }
        lines.push(indent + '}')
        return lines.join('\n')
    }

    function luaConnections(connections, indent) {
        var keys = Object.keys(connections)
        if (keys.length === 0) return '{}'
        var lines = ['{']
        DIRECTIONS.forEach(function (direction) {
            if (!(direction in connections)) return
            var conn = connections[direction]
            if (conn === DELETE) {
                lines.push(indent + '  ' + direction + ' = mod.DELETE,')
            } else {
                lines.push(indent + '  ' + direction + ' = { map = ' +
                    luaString(conn.map) + ', offset = ' + conn.offset + ' },')
            }
        })
        lines.push(indent + '}')
        return lines.join('\n')
    }

    /* One field of a map payload, at `indent`. */
    function luaMapField(key, value, record, indent) {
        if (key === 'blocks') {
            return indent + 'blocks = ' + luaBlocks(value, record.width, indent) + ','
        }
        if (key === 'connections') {
            return indent + 'connections = ' + luaConnections(value, indent) + ','
        }
        if (key === 'warps') {
            return indent + 'warps = ' + luaRecordList(value, WARP_KEYS, indent) + ','
        }
        if (key === 'signs') {
            return indent + 'signs = ' + luaRecordList(value, SIGN_KEYS, indent) + ','
        }
        if (key === 'objects') {
            return indent + 'objects = ' + luaRecordList(value, OBJECT_KEYS, indent) + ','
        }
        return indent + luaKey(key) + ' = ' + luaScalar(value) + ','
    }

    // ------------------------------------------------------ reading a Tiled map

    /*
     * Tiled reports a typed property in an envelope rather than as the value
     * itself, and the .tmj on disk stores it bare -- so reading the file and
     * reading the live API give two different shapes.  Two flavors:
     *
     *   class: { value: { map: "ROUTE_1", offset: 0 },
     *            typeId: 8, typeName: "Gen1Connection" }
     *   enum:  { value: 1, typeId: 7, typeName: "Gen1ExportMode" }
     *
     * An ENUM's value is its INDEX into the type's `values`, not the name.  So
     * the moment anyone picks a sprite from the SpriteId dropdown rather than
     * typing it, `sprite` arrives as a number and would land in a mod as one.
     * vanilla.json carries the same value lists the project declares, in the
     * same order, which is what turns the index back into the name.
     */
    function unwrapClassValue(value) {
        if (!(value && typeof value === 'object' && !Array.isArray(value) &&
                typeof value.typeName === 'string' &&
                Object.prototype.hasOwnProperty.call(value, 'value'))) {
            return value
        }
        var inner = value.value
        var names = enumValues[value.typeName]
        if (names && typeof inner === 'number') {
            // out of range means the project and the baseline disagree; hand
            // back the index rather than silently inventing a name
            return inner >= 0 && inner < names.length ? names[inner] : inner
        }
        return inner
    }

    function propertyOf(object, name) {
        if (!object) return undefined
        // resolvedProperty folds in the class defaults; property() is the
        // explicitly-set value.  Both are guarded because a tile's `tileset`
        // is not always a full EditableTileset.
        var value
        if (typeof object.resolvedProperty === 'function') {
            value = object.resolvedProperty(name)
        }
        if (value === undefined && typeof object.property === 'function') {
            value = object.property(name)
        }
        return unwrapClassValue(value)
    }

    /*
     * Resolving an enum index needs the baseline loaded first.  Rather than
     * leave that an ordering rule for callers to remember -- it has already
     * been got wrong twice -- any read entry point can top it up from the
     * asset's own path.
     */
    function ensureEnums(asset) {
        if (Object.keys(enumValues).length > 0) return
        if (!(asset && asset.fileName)) return
        try {
            loadBaseline(asset.fileName)
        } catch (error) {
            // a missing baseline is reported where it actually matters, by the
            // caller that needs it to diff; reading can still proceed
        }
    }

    function layersOf(map) {
        var found = { tileLayers: [], objectLayers: {} }
        for (var i = 0; i < map.layerCount; i++) {
            var layer = map.layerAt(i)
            if (layer.isTileLayer) {
                found.tileLayers.push(layer)
            } else if (layer.isObjectLayer) {
                found.objectLayers[layer.name] = layer
            }
        }
        return found
    }

    function blocksLayerOf(map) {
        var found = layersOf(map).tileLayers
        if (found.length === 0) {
            throw new Error('no tile layer -- the block layer is the map')
        }
        for (var i = 0; i < found.length; i++) {
            if (found[i].name === 'blocks') return found[i]
        }
        return found[0]
    }

    /*
     * Which gen1 tileset a Tiled tileset stands for.
     *
     * The workspace ships one atlas per (tileset, palette) pair so each map
     * renders in its real SGB colors -- blocks_OVERWORLD__PALLET,
     * blocks_OVERWORLD__VIRIDIAN and so on.  They are the same 128 blocks in
     * different colors, numbered identically, so blocks pasted between maps on
     * different palettes are still valid: only the gen1 id has to agree.
     */
    function gen1TilesetOf(tileset) {
        if (!tileset) return null
        var declared = propertyOf(tileset, 'gen1Tileset')
        if (!isBlank(declared)) return declared
        // no property (a hand-made tileset): fall back to the name.  Gen1 ids
        // never contain a double underscore, so the first one is the separator
        var name = String(tileset.name || '').replace(/^blocks_/, '')
        var split = name.indexOf('__')
        return split === -1 ? name : name.slice(0, split)
    }

    /* Read the block layer, checking it came from exactly one gen1 tileset. */
    function readBlocks(map, warnings) {
        var layer = blocksLayerOf(map)
        var blocks = []
        var gen1Ids = {}
        var missing = 0
        for (var y = 0; y < map.height; y++) {
            for (var x = 0; x < map.width; x++) {
                var tile = layer.tileAt(x, y)
                if (!tile) {
                    missing++
                    blocks.push(0)
                    continue
                }
                blocks.push(tile.id)
                var owner = gen1TilesetOf(tile.tileset)
                if (owner) gen1Ids[owner] = true
            }
        }
        if (missing > 0) {
            warnings.push(missing + ' empty cell(s) in the block layer exported ' +
                'as block 0; paint every cell to be explicit')
        }
        var ids = Object.keys(gen1Ids)
        if (ids.length > 1) {
            throw new Error('the block layer mixes tilesets (' + ids.join(', ') +
                ') -- one gen1 map draws from exactly one tileset')
        }
        return { blocks: blocks, tilesetId: ids[0] || null }
    }

    function cellOf(object, warnings, what) {
        var x = object.x / CELL_PX
        var y = object.y / CELL_PX
        var snappedX = Math.round(x)
        var snappedY = Math.round(y)
        if (x !== snappedX || y !== snappedY) {
            warnings.push(what + ' "' + (object.name || object.id) +
                '" was off the 16px cell grid and snapped to ' +
                snappedX + ',' + snappedY)
        }
        return { x: snappedX, y: snappedY }
    }

    function readingOrder(a, b) {
        if (a.y !== b.y) return a.y - b.y
        return a.x - b.x
    }

    function readWarps(layer, warnings) {
        if (!layer) return []
        var entries = layer.objects.map(function (object) {
            var cell = cellOf(object, warnings, 'warp')
            var declared = propertyOf(object, 'warpIndex')
            return {
                x: cell.x, y: cell.y,
                destMap: propertyOf(object, 'destMap') || '',
                destWarp: propertyOf(object, 'destWarp') || 1,
                _order: isBlank(declared) ? null : declared
            }
        })
        return orderEntries(entries, warnings, 'warp')
    }

    function readSigns(layer, warnings) {
        if (!layer) return []
        var entries = layer.objects.map(function (object) {
            var cell = cellOf(object, warnings, 'sign')
            var declared = propertyOf(object, 'signIndex')
            return {
                x: cell.x, y: cell.y,
                text: propertyOf(object, 'text') || '',
                _order: isBlank(declared) || declared === 0 ? null : declared
            }
        })
        return orderEntries(entries, warnings, 'sign')
    }

    /*
     * Warp and object order is load bearing: a warp is addressed by its 1-based
     * position (destWarp points at one) and a script addresses an NPC by its
     * object index.  So an explicit index wins, and anything unnumbered falls
     * in behind in reading order rather than in Tiled's creation order.
     */
    function orderEntries(entries, warnings, what) {
        var numbered = entries.filter(function (e) { return e._order !== null })
        var loose = entries.filter(function (e) { return e._order === null })
        numbered.sort(function (a, b) { return a._order - b._order })
        loose.sort(readingOrder)
        var ordered = numbered.concat(loose)
        if (loose.length > 0 && numbered.length > 0) {
            warnings.push(loose.length + ' new ' + what + '(s) had no index and ' +
                'were appended after the numbered ones')
        }
        return ordered.map(function (entry) {
            delete entry._order
            return entry
        })
    }

    function readObjects(layer, warnings) {
        if (!layer) return []
        var entries = layer.objects.map(function (object) {
            var cell = cellOf(object, warnings, 'object')
            var declared = propertyOf(object, 'objectIndex')
            var record = {
                name: object.name || '',
                sprite: propertyOf(object, 'sprite') || 'SPRITE_YOUNGSTER',
                movement: propertyOf(object, 'movement') || 'STAY',
                range: propertyOf(object, 'range') || 'NONE',
                text: propertyOf(object, 'text') || '',
                x: cell.x, y: cell.y,
                _order: isBlank(declared) || declared === 0 ? null : declared
            }
            var trainerClass = propertyOf(object, 'trainerClass')
            var trainerParty = propertyOf(object, 'trainerParty')
            if (!isBlank(trainerClass)) {
                record.trainerClass = trainerClass
                record.trainerParty = isBlank(trainerParty) ? 1 : trainerParty
            }
            var item = propertyOf(object, 'item')
            if (!isBlank(item)) record.item = item
            var pokemon = propertyOf(object, 'pokemon')
            if (!isBlank(pokemon)) {
                record.pokemon = pokemon
                var level = propertyOf(object, 'level')
                if (!isBlank(level) && level !== 0) record.level = level
            }
            if (propertyOf(object, 'hidden') === true) record.hidden = true
            return record
        })
        var ordered = orderEntries(entries, warnings, 'object')
        ordered.forEach(function (entry, position) {
            entry.index = position + 1
        })
        return ordered
    }

    function readConnections(map) {
        var connections = {}
        DIRECTIONS.forEach(function (direction) {
            var key = 'connect' + direction.charAt(0).toUpperCase() + direction.slice(1)
            var value = propertyOf(map, key)
            if (!value || typeof value !== 'object') return
            if (isBlank(value.map)) return
            connections[direction] = {
                map: value.map,
                offset: isBlank(value.offset) ? 0 : value.offset
            }
        })
        return connections
    }

    /* Turn one open Tiled map into a gen1 map record plus its identity. */
    function readMap(map) {
        var warnings = []
        ensureEnums(map)
        if (map.tileWidth !== BLOCK_PX || map.tileHeight !== BLOCK_PX) {
            throw new Error('tile size is ' + map.tileWidth + 'x' + map.tileHeight +
                ' -- a gen1 block map must be ' + BLOCK_PX + 'x' + BLOCK_PX)
        }
        if (map.infinite) {
            throw new Error('map is infinite -- a gen1 map has a fixed ' +
                'width x height in blocks')
        }

        var mapId = propertyOf(map, 'mapId')
        if (isBlank(mapId)) {
            throw new Error('no mapId property -- set the map\'s Class to ' +
                'Gen1Map and fill in mapId')
        }

        var read = readBlocks(map, warnings)
        var tilesetId = propertyOf(map, 'tileset')
        if (isBlank(tilesetId)) tilesetId = read.tilesetId
        if (isBlank(tilesetId)) {
            throw new Error('no tileset property and the block tileset is ' +
                'unnamed -- set the map\'s tileset')
        }
        if (read.tilesetId && read.tilesetId !== tilesetId) {
            warnings.push('the map\'s tileset property (' + tilesetId + ') does ' +
                'not match the tileset it draws from (' + read.tilesetId + ')')
        }

        var layers = layersOf(map).objectLayers
        var record = {
            id: mapId,
            label: propertyOf(map, 'label') || mapId,
            tileset: tilesetId,
            width: map.width,
            height: map.height,
            blocks: read.blocks,
            borderBlock: propertyOf(map, 'borderBlock') || 0,
            connections: readConnections(map),
            warps: readWarps(layers.warps, warnings),
            signs: readSigns(layers.signs, warnings),
            objects: readObjects(layers.objects, warnings)
        }

        var index = propertyOf(map, 'index')
        if (!isBlank(index) && index !== 0) record.index = index

        // A named palette on the record beats the field.palettes cascade
        // (OverworldController.lua:506).  Only carried when it differs from
        // what the map already renders with -- see diffMap.
        var palette = propertyOf(map, 'palette')
        if (!isBlank(palette)) record.palette = palette

        return {
            record: record,
            mapId: mapId,
            isVanilla: propertyOf(map, 'vanilla') === true,
            // off: the minimal diff, which composes with other mods.
            // on: the whole record, which is exactly what you see and wins.
            exact: propertyOf(map, 'exactExport') === true,
            warnings: warnings
        }
    }

    // --------------------------------------------------- reading a blockset map

    /*
     * A blockset composer map is 8x8 tiles laid out four-by-four per block, in
     * the same order as the generated atlas.  Read each 4x4 region back as one
     * `blocks` row of 16 tile ids.
     */
    function readBlockset(map) {
        var warnings = []
        ensureEnums(map)
        if (map.tileWidth !== TILE_PX || map.tileHeight !== TILE_PX) {
            throw new Error('a blockset map must have ' + TILE_PX + 'x' + TILE_PX +
                ' tiles, got ' + map.tileWidth + 'x' + map.tileHeight)
        }
        var tilesetId = propertyOf(map, 'gen1Tileset')
        if (isBlank(tilesetId)) {
            throw new Error('no gen1Tileset property -- set the map\'s Class to ' +
                'Gen1Blockset and name the tileset')
        }

        var perRow = propertyOf(map, 'blocksPerRow')
        if (isBlank(perRow) || perRow <= 0) perRow = Math.floor(map.width / 4)
        var declaredCount = propertyOf(map, 'blockCount')

        var layer = blocksLayerOf(map)
        var rows = Math.floor(map.height / 4)
        var capacity = rows * perRow
        var count = (!isBlank(declaredCount) && declaredCount > 0)
            ? Math.min(declaredCount, capacity)
            : capacity

        var blocks = []
        var tilesets = {}
        var emptied = 0
        for (var index = 0; index < count; index++) {
            var baseX = (index % perRow) * 4
            var baseY = Math.floor(index / perRow) * 4
            var row = []
            for (var slot = 0; slot < 16; slot++) {
                var tile = layer.tileAt(baseX + (slot % 4), baseY + Math.floor(slot / 4))
                if (!tile) {
                    emptied++
                    row.push(0)
                } else {
                    row.push(tile.id)
                    if (tile.tileset) tilesets[tile.tileset.name] = true
                }
            }
            blocks.push(row)
        }
        if (emptied > 0) {
            warnings.push(emptied + ' empty tile(s) in the blockset exported as ' +
                'tile 0')
        }

        var names = Object.keys(tilesets)
        if (names.length > 1) {
            throw new Error('the blockset mixes tile sheets (' + names.join(', ') +
                ') -- one gen1 tileset has exactly one sheet')
        }

        return {
            tilesetId: tilesetId,
            blocks: blocks,
            blocksPerRow: perRow,
            animation: propertyOf(map, 'animation') || null,
            sheetName: names[0] || null,
            warnings: warnings
        }
    }

    /*
     * Where a tileset's 8x8 sheet should come from in the exported mod.
     *
     * The generated tiles_<ID>.png is a recolored copy of the player's own
     * imported sheet, so a tileset still drawing on it references the import's
     * own path rather than shipping the pixels.  An author's own sheet -- one
     * from outside the generated workspace -- is copied into the mod.
     */
    function readSheet(tileset, tilesetId, workspace, baseline) {
        var absolute = tileset ? tileset.imageFileName : ''
        var base = baseline.tilesets[tilesetId]
        var fromWorkspace = workspace && absolute &&
            absolute.indexOf(workspace) === 0

        if (fromWorkspace && base && base.image) {
            return {
                image: { path: base.image, modLocal: false },
                copyFrom: null,
                copyTo: null,
                imageWidth: base.imageWidth,
                imageHeight: base.imageHeight,
                tilesPerRow: base.tilesPerRow
            }
        }

        var relative = 'assets/' + FileInfo.baseName(absolute) + '.png'
        return {
            image: { path: relative, modLocal: true },
            copyFrom: absolute,
            copyTo: relative,
            imageWidth: tileset ? tileset.imageWidth : null,
            imageHeight: tileset ? tileset.imageHeight : null,
            tilesPerRow: tileset ? tileset.columnCount : null
        }
    }

    /* Flag lists for a tileset record, read off the 8x8 sheet's tiles. */
    function readTileFlags(tileset) {
        var lists = {}
        var grassTile = null
        var warpPads = {}
        var hasPads = false

        TILE_FLAG_LISTS.forEach(function (entry) { lists[entry.field] = [] })

        var tiles = tileset.tiles
        for (var i = 0; i < tiles.length; i++) {
            var tile = tiles[i]
            TILE_FLAG_LISTS.forEach(function (entry) {
                if (propertyOf(tile, entry.property) === true) {
                    lists[entry.field].push(tile.id)
                }
            })
            if (propertyOf(tile, 'grass') === true && grassTile === null) {
                grassTile = tile.id
            }
            var pad = propertyOf(tile, 'warpPad')
            if (!isBlank(pad)) {
                warpPads[tile.id] = pad
                hasPads = true
            }
        }

        var out = {}
        Object.keys(lists).forEach(function (field) {
            if (lists[field].length > 0) {
                out[field] = lists[field].sort(function (a, b) { return a - b })
            }
        })
        if (grassTile !== null) out.grassTile = grassTile
        if (hasPads) out.warpPadTiles = warpPads
        return out
    }

    // ----------------------------------------------------------------- diffing

    /* Every field of a record, for a register or an override. */
    function wholeRecord(record) {
        var fields = {}
        MAP_FIELD_ORDER.forEach(function (key) {
            if (key === 'id') return
            if (key in record) fields[key] = record[key]
        })
        return fields
    }

    /*
     * Pick the verb and the payload.
     *
     * The verb follows whether the BASE DATA owns this id, not the map's
     * `vanilla` property -- that flag is an author hint and can be wrong, while
     * Registry:register errors outright on an id that already exists
     * (src/mods/Registry.lua:95).  Choosing on the property instead would turn
     * a mislabelled map into a hard load failure.
     *
     *   unknown id            -> register  (the whole record)
     *   known id, exactExport -> override  (the whole record, wins outright)
     *   known id, otherwise   -> patch     (only what moved)
     */
    function diffMap(read, baseline) {
        var record = read.record
        var known = Object.prototype.hasOwnProperty.call(baseline.maps, read.mapId)
        var base = known ? baseline.maps[read.mapId] : null
        var warnings = []

        if (read.isVanilla !== known) {
            warnings.push(known
                ? 'marked as not vanilla, but ' + read.mapId + ' is a base game ' +
                  'map -- exporting against the base record anyway'
                : 'marked as vanilla, but ' + read.mapId + ' is not a base game ' +
                  'map -- exporting it as a new map')
        }

        if (!known) {
            var newFields = wholeRecord(record)
            if (isBlank(newFields.index)) newFields.index = baseline.nextModMapIndex
            return { verb: 'register', fields: newFields, warnings: warnings }
        }

        if (read.exact) {
            var exactFields = wholeRecord(record)
            // an override drops what it does not name, and index is load
            // bearing (the indoor and connection-range compares read it), so
            // it must never fall out of the record
            if (isBlank(exactFields.index)) exactFields.index = base.index
            if (isBlank(exactFields.borderBlock)) {
                exactFields.borderBlock = base.borderBlock
            }
            warnings.push('exact mode: overrides the whole ' + read.mapId +
                ' record, so it wins over any other mod that patches this map ' +
                'and freezes fields you did not edit')
            return { verb: 'override', fields: exactFields, warnings: warnings }
        }

        var changed = {}

        ;['label', 'index', 'tileset', 'borderBlock'].forEach(function (key) {
            if (isBlank(record[key])) return
            if (record[key] !== base[key]) changed[key] = record[key]
        })

        // The palette is not a field of the map record in the imported data --
        // vanilla resolves it through the cascade -- so it diffs against what
        // the map renders with today, and only a real change is carried.
        var basePalette = (baseline.paletteByMap || {})[read.mapId]
        if (!isBlank(record.palette) && record.palette !== basePalette) {
            changed.palette = record.palette
        }

        var geometryMoved = record.width !== base.width || record.height !== base.height
        if (geometryMoved || !deepEqual(record.blocks, base.blocks)) {
            // width and height ride along with blocks so the schema's
            // #blocks == width*height check has something to check
            changed.width = record.width
            changed.height = record.height
            changed.blocks = record.blocks
        }

        ;['warps', 'signs', 'objects'].forEach(function (key) {
            if (!deepEqual(record[key], base[key] || [])) changed[key] = record[key]
        })

        var baseConnections = base.connections || {}
        var connections = {}
        var connectionsMoved = false
        DIRECTIONS.forEach(function (direction) {
            var mine = record.connections[direction]
            var theirs = baseConnections[direction]
            if (mine && !deepEqual(mine, theirs)) {
                connections[direction] = mine
                connectionsMoved = true
            } else if (!mine && theirs) {
                // a dictionary merges per key, so a dropped direction has to
                // be unset explicitly or the vanilla one survives the patch
                connections[direction] = DELETE
                connectionsMoved = true
            }
        })
        if (connectionsMoved) changed.connections = connections

        if (changed.connections) {
            DIRECTIONS.forEach(function (direction) {
                var conn = changed.connections[direction]
                if (conn && conn !== DELETE && !(conn.map in baseline.maps)) {
                    warnings.push('connects ' + direction + ' to ' + conn.map +
                        ', which is not a vanilla map -- make sure the mod ' +
                        'registers it and patches the return connection')
                }
            })
        }

        return { verb: 'patch', fields: changed, warnings: warnings }
    }

    /*
     * Same call as diffMap, for a blockset.  An id the imported data already
     * owns is patched (register would collide under record semantics); a new id
     * is registered whole.
     *
     * `image` is deliberately never a copy of a vanilla sheet.  The port ships
     * no extracted art, so a tileset still drawing on the player's imported
     * sheet references that path -- the same thing tests/mod_world_tests.lua:312
     * does -- and only an author's own sheet is carried inside the mod.
     */
    var OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' }

    /*
     * The other half of every connection you draw.
     *
     * A connection is stored on both maps, so hooking a new map onto Kanto only
     * half works if the base map is not told to point back -- you walk in and
     * cannot walk out.  Every one of the 78 vanilla reciprocal pairs satisfies
     * `back.offset == -offset` (the perpendicular axis is implied by the
     * direction, per OverworldController.computeNeighbors:146-154), so the
     * return connection is derivable rather than something to hand-write.
     *
     * Returns { mapId: { direction: connection } } for BASE maps that need
     * patching.  Maps the export already carries are skipped: their author owns
     * both sides.
     */
    function reciprocalConnections(reads, baseline) {
        var authored = {}
        reads.forEach(function (read) { authored[read.mapId] = true })

        var needed = {}
        reads.forEach(function (read) {
            DIRECTIONS.forEach(function (direction) {
                var conn = read.record.connections[direction]
                if (!conn || isBlank(conn.map)) return
                if (authored[conn.map]) return

                var base = baseline.maps[conn.map]
                if (!base) return  // unknown map; diffMap warns about it

                var opposite = OPPOSITE[direction]
                var back = { map: read.mapId, offset: -(conn.offset || 0) }
                var existing = (base.connections || {})[opposite]
                if (existing && existing.map === back.map &&
                        existing.offset === back.offset) {
                    return  // the base game already points back correctly
                }
                needed[conn.map] = needed[conn.map] || {}
                needed[conn.map][opposite] = back
            })
        })
        return needed
    }

    /* The `maps:patch` call that hooks a base map back to an authored one. */
    function reciprocalChunk(mapId, connections, indent) {
        indent = indent || '  '
        var inner = indent + '  '
        return [
            indent + 'mod.content.maps:patch(' + luaString(mapId) + ', {',
            inner + 'connections = ' + luaConnections(connections, inner) + ',',
            indent + '})'
        ].join('\n')
    }

    function diffTileset(read, flags, baseline) {
        var base = baseline.tilesets[read.tilesetId]
        var warnings = []

        if (!base) {
            var fields = {
                blocks: read.blocks,
                image: flags.image,
                imageWidth: flags.imageWidth,
                imageHeight: flags.imageHeight,
                tilesPerRow: flags.tilesPerRow
            }
            if (read.animation) fields.animation = read.animation
            TILE_FLAG_LISTS.forEach(function (entry) {
                if (flags[entry.field]) fields[entry.field] = flags[entry.field]
            })
            if (!isBlank(flags.grassTile)) fields.grassTile = flags.grassTile
            if (flags.warpPadTiles) fields.warpPadTiles = flags.warpPadTiles
            if (!fields.walkable) {
                warnings.push('no tile is flagged walkable, so every cell of a map ' +
                    'on this tileset will be solid -- flag walkable tiles on ' +
                    'tiles_' + read.tilesetId)
            }
            return { verb: 'register', fields: fields, warnings: warnings }
        }

        var changed = {}
        if (!deepEqual(read.blocks, base.blocks || [])) changed.blocks = read.blocks
        TILE_FLAG_LISTS.forEach(function (entry) {
            var mine = flags[entry.field] || []
            var theirs = base[entry.field] || []
            if (!deepEqual(mine, theirs)) changed[entry.field] = mine
        })
        if (!isBlank(flags.grassTile) && flags.grassTile !== base.grassTile) {
            changed.grassTile = flags.grassTile
        }
        if (read.animation && read.animation !== base.animation) {
            changed.animation = read.animation
        }
        return { verb: 'patch', fields: changed, warnings: warnings }
    }

    // ------------------------------------------------------- emitting Lua

    /* The `mod.content.maps:<verb>(...)` call for one map. */
    function mapChunk(read, diff, indent) {
        indent = indent || '  '
        var inner = indent + '  '
        var lines = []
        lines.push(indent + 'mod.content.maps:' + diff.verb + '(' +
            luaString(read.mapId) + ', {')
        // a patch names only what moves; the two whole-record verbs carry id
        if (diff.verb === 'register' || diff.verb === 'override') {
            lines.push(inner + 'id = ' + luaString(read.mapId) + ',')
        }
        MAP_FIELD_ORDER.forEach(function (key) {
            if (key === 'id') return
            if (!(key in diff.fields)) return
            lines.push(luaMapField(key, diff.fields[key], read.record, inner))
        })
        lines.push(indent + '})')
        return lines.join('\n')
    }

    var TILESET_FIELD_ORDER = [
        'image', 'imageWidth', 'imageHeight', 'tilesPerRow', 'animation',
        'blocks', 'walkable', 'waterTiles', 'shoreTiles', 'doorTiles',
        'warpTiles', 'counterTiles', 'animatedTiles', 'grassTile',
        'warpPadTiles'
    ]

    /* The `mod.content.tilesets:<verb>(...)` call for one blockset. */
    function tilesetChunk(read, diff, indent) {
        indent = indent || '  '
        var inner = indent + '  '
        var lines = []
        lines.push(indent + 'mod.content.tilesets:' + diff.verb + '(' +
            luaString(read.tilesetId) + ', {')
        if (diff.verb === 'register') {
            lines.push(inner + 'id = ' + luaString(read.tilesetId) + ',')
        }

        TILESET_FIELD_ORDER.forEach(function (key) {
            if (!(key in diff.fields)) return
            var value = diff.fields[key]
            if (isBlank(value)) return

            if (key === 'blocks') {
                lines.push(inner + 'blocks = {')
                value.forEach(function (row) {
                    lines.push(inner + '  { ' + row.join(', ') + ' },')
                })
                lines.push(inner + '},')
            } else if (key === 'image') {
                // a mod-local sheet resolves against mod.path; the player's own
                // imported sheet is referenced where it already lives
                lines.push(inner + 'image = ' + (value.modLocal
                    ? 'mod.path .. ' + luaString('/' + value.path)
                    : luaString(value.path)) + ',')
            } else if (key === 'warpPadTiles') {
                var pads = Object.keys(value).map(function (id) {
                    return '[' + id + '] = ' + luaString(value[id])
                })
                if (pads.length === 0) return
                lines.push(inner + 'warpPadTiles = { ' + pads.join(', ') + ' },')
            } else if (Array.isArray(value)) {
                lines.push(inner + key + ' = { ' + value.join(', ') + ' },')
            } else {
                lines.push(inner + key + ' = ' + luaScalar(value) + ',')
            }
        })

        lines.push(indent + '})')
        return lines.join('\n')
    }

    return {
        BLOCK_PX: BLOCK_PX,
        CELL_PX: CELL_PX,
        TILE_PX: TILE_PX,
        MOD_MAP_INDEX_BASE: MOD_MAP_INDEX_BASE,
        DIRECTIONS: DIRECTIONS,
        DELETE: DELETE,

        isBlank: isBlank,
        deepEqual: deepEqual,
        readJson: readJson,
        writeText: writeText,

        findWorkspace: findWorkspace,
        loadBaseline: loadBaseline,
        forgetBaseline: forgetBaseline,

        luaString: luaString,
        luaKey: luaKey,

        readMap: readMap,
        readBlockset: readBlockset,
        readTileFlags: readTileFlags,
        readSheet: readSheet,

        diffMap: diffMap,
        diffTileset: diffTileset,
        mapChunk: mapChunk,
        tilesetChunk: tilesetChunk,
        reciprocalConnections: reciprocalConnections,
        reciprocalChunk: reciprocalChunk
    }
})()
