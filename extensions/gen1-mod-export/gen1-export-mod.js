/*
 * "Export Gen1 Mod" action: the whole mod construct, not just one map file.
 *
 * File > Export Gen1 Mod... writes a loadable mod directory -- manifest.json,
 * main.lua, one maps/<ID>.lua per changed map, one tilesets/<ID>.lua per changed
 * blockset -- from the maps you have open.
 *
 * Every open Tiled map is considered.  A vanilla map with nothing changed is
 * skipped rather than shipped as an empty patch, so having the whole of Kanto
 * open costs nothing.
 */

var gen1ExportMod = tiled.registerAction('Gen1ExportMod', function () {
    var maps = []
    var blocksets = []
    var problems = []
    var skipped = []

    // Collect the candidates first, WITHOUT reading them.  Resolving an
    // enum-typed property back to its name needs the baseline's value lists, so
    // the baseline has to be loaded before the first property read.
    var candidates = []
    var open = tiled.openAssets
    for (var i = 0; i < open.length; i++) {
        var asset = open[i]
        if (!asset.isTileMap) continue
        // a blockset composer map names a tileset; a play map names a map id
        var isBlockset = !Gen1.isBlank(asset.property('gen1Tileset')) ||
            asset.className === 'Gen1Blockset'
        var isMap = !Gen1.isBlank(asset.property('mapId')) ||
            asset.className === 'Gen1Map'
        if (isBlockset || isMap) {
            candidates.push({ asset: asset, isBlockset: isBlockset })
        }
    }

    if (candidates.length === 0) {
        tiled.alert('Open at least one gen1 map or blockset first.\n\n' +
            'A map needs its Class set to Gen1Map (and a mapId); a blockset ' +
            'needs Gen1Blockset (and a gen1Tileset).',
            'Export Gen1 Mod')
        return
    }

    var baseline
    var workspace
    try {
        var anchor = candidates[0].asset.fileName
        baseline = Gen1.loadBaseline(anchor)
        workspace = Gen1.findWorkspace(anchor)
    } catch (error) {
        tiled.alert(String(error.message || error), 'Export Gen1 Mod')
        return
    }

    candidates.forEach(function (entry) {
        var label = entry.asset.fileName
            ? FileInfo.baseName(entry.asset.fileName)
            : 'untitled map'
        try {
            if (entry.isBlockset) {
                blocksets.push({ asset: entry.asset,
                                 read: Gen1.readBlockset(entry.asset) })
            } else {
                maps.push({ asset: entry.asset,
                            read: Gen1.readMap(entry.asset) })
            }
        } catch (error) {
            problems.push(label + ': ' + String(error.message || error))
        }
    })

    if (maps.length === 0 && blocksets.length === 0) {
        tiled.alert('Nothing exportable could be read.\n\n' +
            problems.join('\n'), 'Export Gen1 Mod')
        return
    }

    // ---------------------------------------------------------- diff everything

    var mapChunks = []
    var nextIndex = baseline.nextModMapIndex
    var warnings = []

    maps.forEach(function (entry) {
        var diff
        try {
            diff = Gen1.diffMap(entry.read, baseline)
        } catch (error) {
            problems.push(entry.read.mapId + ': ' + String(error.message || error))
            return
        }
        if (diff.verb === 'patch' && Object.keys(diff.fields).length === 0) {
            skipped.push(entry.read.mapId + ' (unchanged)')
            return
        }
        if (diff.verb === 'register') {
            // hand out distinct indices when several new maps are exported at once
            diff.fields.index = nextIndex
            nextIndex++
        }
        entry.read.warnings.concat(diff.warnings).forEach(function (warning) {
            warnings.push(entry.read.mapId + ': ' + warning)
        })
        mapChunks.push({ read: entry.read, diff: diff })
    })

    var tilesetChunks = []
    var copies = []

    blocksets.forEach(function (entry) {
        var read = entry.read
        var tileset = entry.asset.tilesets.length > 0 ? entry.asset.tilesets[0] : null
        var sheet = Gen1.readSheet(tileset, read.tilesetId, workspace, baseline)
        var flags = tileset ? Gen1.readTileFlags(tileset) : {}
        flags.image = sheet.image
        flags.imageWidth = sheet.imageWidth
        flags.imageHeight = sheet.imageHeight
        flags.tilesPerRow = sheet.tilesPerRow

        var diff
        try {
            diff = Gen1.diffTileset(read, flags, baseline)
        } catch (error) {
            problems.push(read.tilesetId + ': ' + String(error.message || error))
            return
        }
        if (diff.verb === 'patch' && Object.keys(diff.fields).length === 0) {
            skipped.push(read.tilesetId + ' (unchanged)')
            return
        }
        read.warnings.concat(diff.warnings).forEach(function (warning) {
            warnings.push(read.tilesetId + ': ' + warning)
        })
        if (sheet.copyFrom) {
            copies.push({ from: sheet.copyFrom, to: sheet.copyTo })
        }
        tilesetChunks.push({ read: read, diff: diff })
    })

    // Hook the base game back to whatever this export attaches to it, so a new
    // map you can walk into is also one you can walk out of.
    var reciprocalChunks = []
    var reciprocals = Gen1.reciprocalConnections(
        mapChunks.map(function (entry) { return entry.read }), baseline)
    Object.keys(reciprocals).sort().forEach(function (mapId) {
        var connections = reciprocals[mapId]
        reciprocalChunks.push({ mapId: mapId, connections: connections })
        Object.keys(connections).forEach(function (direction) {
            warnings.push('patching ' + mapId + ' to connect ' + direction +
                ' back to ' + connections[direction].map +
                ' (offset ' + connections[direction].offset + ')')
        })
    })

    if (mapChunks.length === 0 && tilesetChunks.length === 0) {
        tiled.alert('Nothing differs from the imported ROM data, so there is ' +
            'nothing to export.\n\n' +
            (skipped.length > 0 ? 'Unchanged: ' + skipped.join(', ') : ''),
            'Export Gen1 Mod')
        return
    }

    // ------------------------------------------------------------ pick a target

    var target = tiled.promptDirectory('', 'Export Gen1 Mod into an empty folder')
    if (!target) return

    var modId = FileInfo.baseName(target)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
    if (!modId) modId = 'gen1_map_mod'

    // Re-exporting overwrites what this run produces but cannot remove a map
    // file an earlier run left behind, and main.lua only lists this run's --
    // so a stale file would sit there unloaded and confusing.
    var existing = FileInfo.joinPaths(target, 'manifest.json')
    if (File.exists(existing)) {
        var previousId = null
        try {
            previousId = Gen1.readJson(existing).id
        } catch (error) {
            previousId = null
        }
        warnings.push(previousId === modId
            ? 'overwrote an earlier export in this folder; a map file from a ' +
              'previous run that is not in this one is now stale and unlisted'
            : 'this folder already held a different mod (' + previousId +
              ') -- its files are still there and are not listed in main.lua')
    }

    // ----------------------------------------------------------------- write it

    var files = []

    tilesetChunks.forEach(function (entry) {
        files.push({
            relative: 'tilesets/' + entry.read.tilesetId + '.lua',
            body: Gen1.tilesetChunk(entry.read, entry.diff, '  '),
            title: entry.read.tilesetId + ' tileset (' + entry.diff.verb + ')'
        })
    })
    mapChunks.forEach(function (entry) {
        files.push({
            relative: 'maps/' + entry.read.mapId + '.lua',
            body: Gen1.mapChunk(entry.read, entry.diff, '  '),
            title: entry.read.mapId + ' (' + entry.diff.verb + ')'
        })
    })
    // last, so the maps they point at are registered by the time they apply
    reciprocalChunks.forEach(function (entry) {
        files.push({
            relative: 'maps/' + entry.mapId + '.connections.lua',
            body: Gen1.reciprocalChunk(entry.mapId, entry.connections, '  '),
            title: entry.mapId + ' return connection(s)'
        })
    })

    try {
        files.forEach(function (file) {
            var lines = [
                '-- ' + file.title + ': exported from Tiled by gen1-mod-export.',
                '-- Applied by main.lua; see the mod README.',
                'return function(mod)',
                file.body,
                'end',
                ''
            ]
            Gen1.writeText(FileInfo.joinPaths(target, file.relative),
                           lines.join('\n'))
        })

        copies.forEach(function (copy) {
            var destination = FileInfo.joinPaths(target, copy.to)
            File.makePath(FileInfo.path(destination))
            if (!File.copy(copy.from, destination)) {
                warnings.push('could not copy the tile sheet ' + copy.from)
            }
        })

        Gen1.writeText(FileInfo.joinPaths(target, 'manifest.json'),
                       manifestJson(modId, baseline, mapChunks, tilesetChunks))
        Gen1.writeText(FileInfo.joinPaths(target, 'main.lua'),
                       mainLua(modId, files))
        Gen1.writeText(FileInfo.joinPaths(target, 'README.md'),
                       readmeMarkdown(modId, mapChunks, tilesetChunks, warnings))
    } catch (error) {
        tiled.alert('Export failed: ' + String(error.message || error),
                    'Export Gen1 Mod')
        return
    }

    // ------------------------------------------------------------- report back

    warnings.forEach(function (warning) { tiled.warn('gen1-mod-export: ' + warning) })
    problems.forEach(function (problem) { tiled.error('gen1-mod-export: ' + problem) })

    var summary = ['Exported ' + modId + ' to:', target, '']
    summary.push(files.length + ' file(s):')
    files.forEach(function (file) { summary.push('  ' + file.relative) })
    if (copies.length > 0) {
        summary.push('')
        summary.push(copies.length + ' tile sheet(s) copied in.')
    }
    if (skipped.length > 0) {
        summary.push('')
        summary.push('Skipped as unchanged: ' + skipped.join(', '))
    }
    if (warnings.length > 0) {
        summary.push('')
        summary.push(warnings.length + ' warning(s) -- see View > Console:')
        warnings.slice(0, 6).forEach(function (w) { summary.push('  ' + w) })
    }
    if (problems.length > 0) {
        summary.push('')
        summary.push(problems.length + ' map(s) could not be read:')
        problems.forEach(function (p) { summary.push('  ' + p) })
    }
    summary.push('')
    summary.push('Validate it with:')
    summary.push('  python3 tools/modkit.py validate ' + target)

    tiled.alert(summary.join('\n'), 'Export Gen1 Mod')
})

gen1ExportMod.text = 'Export Gen1 Mod...'

// There is no menu bar to extend when Tiled runs headlessly (--evaluate,
// --export-map), and the action is what matters there.  Failing to place the
// item must not abort the rest of this file.
try {
    tiled.extendMenu('File', [
        { separator: true },
        { action: 'Gen1ExportMod' }
    ])
} catch (error) {
    tiled.log('gen1-mod-export: no File menu to extend (' +
        String(error.message || error) + '); the action is still registered')
}

// ------------------------------------------------------------- file templates

function manifestJson(modId, baseline, mapChunks, tilesetChunks) {
    var registered = mapChunks.filter(function (e) {
        return e.diff.verb === 'register'
    }).length
    var patched = mapChunks.length - registered

    var described = []
    if (registered > 0) described.push(registered + ' new map(s)')
    if (patched > 0) described.push(patched + ' patched map(s)')
    if (tilesetChunks.length > 0) {
        described.push(tilesetChunks.length + ' tileset change(s)')
    }

    var manifest = {
        id: modId,
        name: modId,
        version: '0.1.0',
        api: baseline.modApi || 2,
        entry: 'main.lua',
        profile: 'content',
        category: 'GAMEPLAY',
        game_version: baseline.gameVersion || '>=0.0.0-0 <2.0.0',
        priority: 100,
        dependencies: [],
        optional_dependencies: [],
        conflicts: [],
        description: 'Map changes authored in Tiled: ' + described.join(', ') + '.'
    }
    return JSON.stringify(manifest, null, 2) + '\n'
}

function mainLua(modId, files) {
    var lines = []
    lines.push('-- ' + modId + ': map changes authored in Tiled and exported by')
    lines.push('-- gen1-mod-export.  Each file below returns function(mod) and is')
    lines.push('-- applied in order, so tilesets land before the maps that use them.')
    lines.push('--')
    lines.push('-- mod:read + load is how a mod loads its own extra files (the same')
    lines.push('-- shape mods/examples/example_jukebox uses for song.lua).')
    lines.push('local FILES = {')
    files.forEach(function (file) {
        lines.push('  ' + Gen1.luaString(file.relative) + ',')
    })
    lines.push('}')
    lines.push('')
    lines.push('return function(mod)')
    lines.push('  for _, relative in ipairs(FILES) do')
    lines.push('    local source = mod:read(relative)')
    lines.push('    if not source then')
    lines.push('      mod.log:error("%s missing from %s -- reinstall the mod",')
    lines.push('        relative, mod.path)')
    lines.push('    else')
    lines.push('      local chunk, compileErr = load(source,')
    lines.push('        "@" .. mod.path .. "/" .. relative)')
    lines.push('      if not chunk then')
    lines.push('        mod.log:error("%s did not compile: %s", relative,')
    lines.push('          tostring(compileErr))')
    lines.push('      else')
    lines.push('        local ok, apply = pcall(chunk)')
    lines.push('        if not ok or type(apply) ~= "function" then')
    lines.push('          mod.log:error("%s must return function(mod): %s",')
    lines.push('            relative, tostring(apply))')
    lines.push('        else')
    lines.push('          apply(mod)')
    lines.push('        end')
    lines.push('      end')
    lines.push('    end')
    lines.push('  end')
    lines.push('end')
    lines.push('')
    return lines.join('\n')
}

function readmeMarkdown(modId, mapChunks, tilesetChunks, warnings) {
    var lines = []
    lines.push('# ' + modId)
    lines.push('')
    lines.push('Map changes authored in Tiled and exported by `gen1-mod-export`.')
    lines.push('')

    if (tilesetChunks.length > 0) {
        lines.push('## Tilesets')
        lines.push('')
        tilesetChunks.forEach(function (entry) {
            lines.push('- `' + entry.read.tilesetId + '` -- ' + entry.diff.verb +
                ', ' + entry.read.blocks.length + ' block(s)')
        })
        lines.push('')
    }

    lines.push('## Maps')
    lines.push('')
    mapChunks.forEach(function (entry) {
        var fields = Object.keys(entry.diff.fields)
        lines.push('- `' + entry.read.mapId + '` -- ' + entry.diff.verb +
            (entry.diff.verb === 'patch'
                ? ' (' + fields.join(', ') + ')'
                : ' at index ' + entry.diff.fields.index))
    })
    lines.push('')

    if (warnings.length > 0) {
        lines.push('## Warnings from the export')
        lines.push('')
        warnings.forEach(function (warning) { lines.push('- ' + warning) })
        lines.push('')
    }

    lines.push('## Checking it')
    lines.push('')
    lines.push('```sh')
    lines.push('python3 tools/modkit.py validate <this directory>')
    lines.push('python3 tools/modkit.py lint <this directory>')
    lines.push('```')
    lines.push('')
    lines.push('`validate` drives the real engine loader headlessly, so anything')
    lines.push('it accepts will load in game. Then drop this directory into the')
    lines.push('game\'s `mods/` folder and run with `POKEPORT_DEV=1` for F5 reloads.')
    lines.push('')
    lines.push('A patched map only carries the fields that differ from the')
    lines.push('imported ROM data; every field it does not name keeps its base')
    lines.push('value. Connections merge per direction, so a direction this mod')
    lines.push('does not mention is left exactly as the base game had it.')
    lines.push('')
    return lines.join('\n')
}
