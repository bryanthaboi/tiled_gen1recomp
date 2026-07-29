/*
 * Loads the generated overworld as a Tiled world, automatically.
 *
 * WHY NOT JUST OPEN EVERY MAP
 *
 * 222 map tabs and 48 tileset tabs is not a workspace, it is a wall.  A Tiled
 * *world* is the feature that actually wants to be used here: with a world
 * loaded, opening ONE map draws its neighbors around it at their real offsets
 * and lets you scroll and edit straight across the seams.  So the overworld
 * arrives as one continuous surface, and interiors stay one click away in the
 * project panel, which is where a file browser belongs.
 *
 * A world is session state rather than project state (mainwindow.cpp:1559 loads
 * it from the session), so there is no project field that can express "this
 * workspace has a world".  Scripting is the mechanism: tiled.loadWorld.
 */

;(function () {
    'use strict'

    var WORLD_NAME = 'kanto.world'

    function workspaceDir() {
        if (!tiled.projectFilePath) return null
        return FileInfo.path(tiled.projectFilePath)
    }

    function worldPath() {
        var dir = workspaceDir()
        if (!dir) return null
        var candidate = FileInfo.joinPaths(dir, WORLD_NAME)
        return File.exists(candidate) ? candidate : null
    }

    function alreadyLoaded(path) {
        // tiled.worlds needs the document manager, so it throws or comes back
        // empty when Tiled runs headlessly -- either way, nothing to skip
        try {
            var loaded = tiled.worlds || []
            for (var i = 0; i < loaded.length; i++) {
                if (loaded[i] && loaded[i].fileName === path) return true
            }
        } catch (error) {
            return false
        }
        return false
    }

    function load(announce) {
        var path = worldPath()
        if (!path) {
            if (announce) {
                tiled.alert('No ' + WORLD_NAME + ' in this project.\n\n' +
                    'Regenerate the workspace with:\n' +
                    '  python3 tools/tiled_export.py',
                    'Gen1 Overworld')
            }
            return false
        }
        if (alreadyLoaded(path)) {
            if (announce) {
                tiled.alert('The overworld is already loaded.\n\n' + path,
                    'Gen1 Overworld')
            }
            return true
        }
        try {
            tiled.loadWorld(path)
            tiled.log('gen1-mod-export: loaded ' + WORLD_NAME +
                ' -- open any connected map to edit across the seams')
            return true
        } catch (error) {
            tiled.log('gen1-mod-export: could not load ' + WORLD_NAME + ': ' +
                String(error.message || error))
            return false
        }
    }

    // Manual re-load, for after a regenerate or a deliberate unload.
    var action = tiled.registerAction('Gen1LoadOverworld', function () {
        load(true)
    })
    action.text = 'Load Gen1 Overworld'

    try {
        tiled.extendMenu('Map', [
            { separator: true },
            { action: 'Gen1LoadOverworld' }
        ])
    } catch (error) {
        // no menu bar headlessly; the action is still registered
    }

    /*
     * The world normally arrives without this file doing anything: the
     * generated workspace seeds `loadedWorlds` in gen1.tiled-session, and
     * MainWindow::restoreSession loads it (mainwindow.cpp:1559).  That is the
     * mechanism to rely on -- extensions are evaluated before the session is
     * restored, and the loaded set is only captured on aboutToSwitchSession
     * (:596), so a script cannot win that race.
     *
     * This immediate attempt is just a fallback for a workspace whose session
     * was thrown away, and the menu action covers a deliberate reload.
     */
    load(false)
})()
