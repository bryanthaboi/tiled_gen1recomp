/*
 * "Pokemon Gen1 mod map (Lua)" export format: one map, one file.
 *
 * This is the "just the file I need to change the map" export.  File > Export As
 * and pick this format, or File > Export (Ctrl+E) to repeat it.  The result is a
 * chunk returning function(mod), which is what a mod's main.lua applies.
 *
 * A map carrying vanilla: true diffs against the imported ROM data and emits
 * mod.content.maps:patch with only the fields that moved.  Anything else emits
 * mod.content.maps:register.
 */

tiled.registerMapFormat('gen1mod', {
    name: 'Pokemon Gen1 mod map (Lua)',
    extension: 'lua',

    write: function (map, fileName) {
        var read
        var diff
        var baseline
        try {
            baseline = Gen1.loadBaseline(map.fileName || fileName)
            read = Gen1.readMap(map)
            diff = Gen1.diffMap(read, baseline)
        } catch (error) {
            return String(error.message || error)
        }

        var relative = 'maps/' + read.mapId + '.lua'
        var fieldCount = Object.keys(diff.fields).length
        var lines = []

        lines.push('-- ' + read.mapId + ': exported from Tiled by gen1-mod-export.')
        lines.push('--')
        if (diff.verb === 'patch') {
            if (fieldCount === 0) {
                lines.push('-- Nothing differs from the imported ROM data, so this patch is')
                lines.push('-- deliberately empty: applying it is a no-op.')
            } else {
                lines.push('-- Patches the vanilla ' + read.mapId + ': ' + fieldCount +
                    ' field(s) differ from the imported ROM data.  Every field not')
                lines.push('-- named here keeps its base value.')
            }
        } else if (diff.verb === 'override') {
            lines.push('-- Replaces the whole ' + read.mapId + ' record (exactExport).  The map')
            lines.push('-- is exactly what the editor shows, and this wins outright over any')
            lines.push('-- other mod that patches it.')
        } else {
            lines.push('-- Registers ' + read.mapId + ' as a new map at index ' +
                diff.fields.index + '.  Ids at or above ' + Gen1.MOD_MAP_INDEX_BASE)
            lines.push('-- are the range the loader reserves for mod maps.')
        }
        lines.push('--')
        lines.push('-- This chunk returns function(mod).  Load it from main.lua the way the')
        lines.push('-- engine loads any extra mod file:')
        lines.push('--')
        lines.push('--     local source = mod:read("' + relative + '")')
        lines.push('--     local chunk = load(source, "@" .. mod.path .. "/' + relative + '")')
        lines.push('--     chunk()(mod)')
        lines.push('--')
        lines.push('-- ... or paste the body straight into main.lua.')

        read.warnings.concat(diff.warnings).forEach(function (warning) {
            lines.push('-- NOTE: ' + warning)
        })

        lines.push('return function(mod)')
        lines.push(Gen1.mapChunk(read, diff, '  '))
        lines.push('end')
        lines.push('')

        try {
            Gen1.writeText(fileName, lines.join('\n'))
        } catch (error) {
            return 'could not write ' + fileName + ': ' + String(error.message || error)
        }

        read.warnings.concat(diff.warnings).forEach(function (warning) {
            tiled.warn(read.mapId + ': ' + warning)
        })
        tiled.log('gen1-mod-export: ' + read.mapId + ' -> ' + diff.verb + ' (' +
            fieldCount + ' field(s)) -> ' + fileName)
        return undefined
    }
})
