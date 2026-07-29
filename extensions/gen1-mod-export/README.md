# gen1-mod-export

Exports Tiled maps as Pokemon Gen 1 recomp mods.

Two exports, because there are two things you might want:

| Want | Do |
| --- | --- |
| Just the file that changes one map | **File > Export As**, pick *Pokemon Gen1 mod map (Lua)* |
| The whole loadable mod folder | **File > Export Gen1 Mod...** |

## Setup

The workspace comes from the port's repo, not from here:

```sh
python3 tools/tiled_export.py          # -> build/tiled/
```

Open `build/tiled/gen1.tiled-project` in Tiled. The project's `extensionsPath`
points back at this directory, so the format and the action load themselves --
nothing to install.

**One-time consent.** Tiled 1.12 does not run a project's extensions until you
allow that project specifically (`scriptmanager.cpp:423`). The first time you
open the project Tiled offers to enable scripting -- say yes, or use
*Edit > Preferences > Scripting*. Until you do, the export format and the
*Export Gen1 Mod* item are simply absent, with no error to explain why.

Headless runs need the same consent, which is stored per project path:

```sh
# macOS
defaults write org.mapeditor.Tiled "Scripting.EnabledProjects" \
    -array "$PWD/build/tiled/gen1.tiled-project"

# check the extension is live: gen1mod should be in the list
Tiled --project build/tiled/gen1.tiled-project --export-formats
```

## The overworld arrives as one surface

`kanto.world` is loaded for you. That is the feature you want rather than 222
open tabs: with a world loaded, opening **one** overworld map draws its
neighbors around it at their real connection offsets, and you scroll and edit
straight across the seams. Zoom out to see how far it reaches.

*Map > Load Gen1 Overworld* reloads it after a deliberate unload.

How it gets loaded is worth knowing, because there are three separate traps.

A loaded world is **session** state, so `tools/tiled_export.py` seeds
`gen1.tiled-session` and Tiled's own `MainWindow::restoreSession` loads it
(`mainwindow.cpp:1559`). A script cannot win that race: extensions are evaluated
in `initializePluginsAndExtensions()`, well before the session is restored, and
the loaded set is only ever captured on `aboutToSwitchSession` (`:596`).

The seeded values have to be exactly right, and each failure is silent:

1. **`loadedWorlds` needs ABSOLUTE paths.** `Session` resolves relative paths
   for `project`, `openFiles`, `activeFile`, `recentFiles`,
   `expandedProjectPaths` and `fileStates` (`session.cpp:64-72`) -- and
   `loadedWorlds` is not on that list. A relative entry goes straight to
   `QFile` and resolves against the process working directory, so the world
   never loads and nothing says so.
2. **`project` must name the project.** With it empty, the project dock comes up
   with no folders at all -- no maps to browse -- and map files load before the
   project's property types are registered, which is what produced
   *"Unrecognized property type: 'Gen1Connection'"* and *"Failed to create
   property ... with type QVariantMap"*.
3. **The seed is merged, never clobbered**, so regenerating keeps your open
   files and expanded folders.

A quick way to tell it worked: open an overworld map, zoom out, and check the
status bar reads 0 errors / 0 warnings.

## Where are all the maps and tilesets?

Only the files you open appear as tabs, which is deliberate. The rest are in the
**Project** panel (the tab beside the open map), which lists the whole
workspace -- all 222 maps, 24 blocksets, 48 tilesets. Double-click any of them.

The **Tilesets** dock shows only the tilesets the *current map* uses, which is
Tiled behavior and exactly right here: one gen1 map draws from exactly one
tileset. There is nothing to open per tileset; a map carries its own.

## What it emits

An edited **vanilla** map (one carrying `vanilla: true` and its `mapId`) is
diffed against `vanilla.json` and emitted as `mod.content.maps:patch` carrying
only the fields that moved:

```lua
mod.content.maps:patch("PALLET_TOWN", {
  width = 10,
  height = 9,
  blocks = {
      1,  79,  82,  82,  79,  11,  80,  82,  82,  80,
    ...
  },
  connections = {
    north = mod.DELETE,
  },
})
```

Anything else is a new map and gets `mod.content.maps:register` with an index at
or above 1000, the range the loader reserves for mod maps.

A changed blockset emits `mod.content.tilesets:patch` (vanilla id) or
`:register` (new id).

### Extending Kanto

Draw a connection from a new map to a base map and the export also writes the
**return** connection, as a patch on the base map:

```lua
mod.content.maps:patch("ROUTE_21", {
  connections = {
    south = { map = "SABLE_COVE", offset = 0 },
  },
})
```

A connection lives on both maps, so without that half you can walk in and not
out. The return offset is derivable, not guesswork: all 78 vanilla reciprocal
pairs satisfy `back.offset == -offset`. Because `connections` is a dictionary it
merges per direction, so Route 21 keeps every other link it had.

Nothing is written for a connection whose other side the export already owns.

### Palettes

Every map is atlased in the SGB palette it renders with, so the workspace looks
like the game. `tilesets/` therefore holds one atlas per (tileset, palette) pair
-- `blocks_OVERWORLD__PALLET`, `blocks_OVERWORLD__VIRIDIAN`, 85 in all. Every
variant numbers its tiles identically, and the exporter recovers the gen1 id from
the tileset's `gen1Tileset` property, so blocks copied between maps of different
palettes are still valid.

Change a map's `palette` property and the export carries it on the record:

```lua
mod.content.maps:patch("PALLET_TOWN", {
  palette = "CINNABAR",
})
```

That one field is the whole patch, because `map.def.palette` beats the
`field.palettes` cascade (`OverworldController.lua:506`) and vanilla maps carry
no palette of their own -- they resolve through byMap / byTileset / byPrefix,
with interiors inheriting the last outdoor map. So the property diffs against
what the map *renders* with (`paletteByMap` in the baseline), not against a field
that does not exist.

The property is `PaletteId`-typed, so Tiled edits it with a **dropdown** of the
real palette names. That matters twice over: it stops typos, and it is the only
way the picker appears at all -- a stored plain-string property shadows the class
member and comes up as free text. `movement` and `range` are typed the same way.
`sprite` and `trainerClass` are deliberately left as free text, because a mod
registers its own and an enum cannot hold a name outside its list.

Enum-typed properties are reported by the live API as an INDEX, not a name, so
resolving them through `vanilla.json` is what keeps `palette = "LAVENDER"` from
exporting as `palette = 5`.

The same closed-list limit applies to a mod's **own** palette: to name one the
dropdown does not know, change that property's type to plain string in Tiled, or
set it in `main.lua`.

`palette` is declared in the maps schema, but as a plain string rather than an
id reference: the ROM-free fixture base carries no palettes at all, so
referencing the palettes registry would fail validation for a good mod wherever
there is no imported dataset. So nothing catches a misspelled palette at load --
it just falls back to the cascade. Hence the dropdown.

### exactExport: the whole record instead of a diff

Tick **exactExport** on a map and it exports as `mod.content.maps:override` with
every field, so the map is exactly what the editor shows. Use it when you want
the map pinned regardless of what the base data or another mod says.

The cost is real, which is why it is off by default: an override wins outright
over any other mod patching that map, freezes fields you never edited, and
carries the full record even where a diff would have carried nothing. A patch
composes; an override does not.

`index` and `borderBlock` are backfilled from the base record if the editor has
them unset, because an override drops what it does not name and `index` is read
by the indoor and connection-range checks.

## Things worth knowing

**Patch is safe for lists.** The maps registry is `semantics = "record"`, and
under record semantics arrays replace wholesale -- list *append* is
deep-registry-only. So a patch carrying `blocks` or `warps` replaces them.

**Connections merge per direction.** A direction the patch does not mention
keeps its base value, so removing one has to be explicit: the exporter emits
`north = mod.DELETE`.

**Order is load bearing.** A warp is addressed by its 1-based position, and a
script addresses an NPC by object index, so `warpIndex` / `objectIndex` /
`signIndex` win over Tiled's creation order. Anything unnumbered falls in behind
in reading order. Vanilla sign order is *not* reading order, which is why signs
carry an index too.

**No ROM art travels.** The generated `tiles_*.png` are recolored copies of the
player's own imported sheet, so a tileset still drawing on one references the
import's path instead of shipping pixels. Only a sheet of your own gets copied
into the mod. `python3 tools/modkit.py lint` enforces this.

**Magenta tiles are ROM padding.** Six vanilla tilesets address tile ids past
their extracted sheet (GATE reaches 223 over 96 tiles) in trailing blocks no map
uses. The editing sheet is padded so those ids stay addressable and round trip
untouched. Don't paint with them.

## Checking an export

```sh
python3 tools/modkit.py validate <mod dir>   # drives the real loader headlessly
python3 tools/modkit.py lint <mod dir>       # distribution gate
```

## Tests

Tiled's API is Qt's, so the extension is tested through a stub of it rather than
inside Tiled:

```sh
node extensions/gen1-mod-export/tests/run.js <workspace> [outDir]
```

The load-bearing assertion is that all 222 untouched vanilla maps and all 24
untouched blocksets diff to an *empty* patch. That is what proves the generator
and the exporter agree on the model, so a patch only ever carries a real edit.

The stubs must keep matching the real API rather than the file format, because
the two differ. A class-typed property is stored bare in the `.tmj`:

```json
{ "name": "connectNorth", "type": "class",
  "propertytype": "Gen1Connection",
  "value": { "map": "ROUTE_1", "offset": 0 } }
```

but arrives from `EditableObject.property` wrapped:

```js
{ value: { map: "ROUTE_1", offset: 0 }, typeId: 7, typeName: "Gen1Connection" }
```

A stub that handed back the bare members passed code that then read every
connection as absent in real Tiled and emitted `mod.DELETE` for all of them.
`Gen1.unwrapClassValue` handles the envelope; the harness reproduces it.

An end-to-end check against real Tiled, which the stubs cannot replace:

```sh
Tiled --project build/tiled/gen1.tiled-project \
      --export-map gen1mod build/tiled/maps/PALLET_TOWN.tmj /tmp/out.lua
```

## Files

- `gen1-core.js` -- the whole model: reading a Tiled map back into a gen1
  record, diffing against vanilla, serializing Lua. Sorts first, so the other
  files can use it (Tiled evaluates an extension's `*.js` alphabetically
  against one shared global).
- `gen1-export-map.js` -- the single-map `.lua` export format.
- `gen1-export-mod.js` -- the whole-mod-folder action.
- `gen1-world.js` -- auto-loads `kanto.world`, plus the manual reload action.
- `tests/harness.js` -- stubs of `tiled`, `TextFile`, `File`, `FileInfo`, and
  `.tmj` -> EditableMap-alike loaders.
- `tests/run.js` -- the tests.
