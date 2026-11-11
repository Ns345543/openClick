(function () {
    var TICKS_PER_SECOND = 254016000000;
    var DONOR_TEMPLATE_NAME = "OpenClickLayerDonor.xml";
    var DONOR_BASE_RATE_TICKS = "4233600000";
    var DONOR_BASE_UID = "3c4a394b-8896-4840-8515-391db20b5da4";
    var DONOR_SEQUENCE_NAME = "openClick Layer Donor";
    var MARK_EPSILON = 0.001;

    function escape(text) {
        return String(text)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, "\\\"")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t");
    }

    function response(ok, code, message) {
        return "{\"ok\":" + (ok ? "true" : "false") +
            ",\"code\":\"" + escape(code) + "\"" +
            ",\"message\":\"" + escape(message) + "\"}";
    }

    function normalizePath(path) {
        return String(path || "").replace(/\\/g, "/").toLowerCase();
    }

    function ticksOf(time) {
        if (!time) return NaN;
        return parseFloat(String(time.ticks));
    }

    function state() {
        if (!$.global.__ALC_STATE__) {
            $.global.__ALC_STATE__ = {
                projectPath: "",
                rateTicks: "",
                adjustmentNodeId: "",
                effectCacheKey: "",
                effectLookup: ""
            };
        }
        return $.global.__ALC_STATE__;
    }

    function selectionItems(sequence) {
        var selection = null;
        try { selection = sequence.getSelection(); } catch (e) { selection = null; }
        if (!selection) return [];
        var count = -1;
        try { count = selection.length; } catch (eLen) { count = -1; }
        if (typeof count !== "number" || count < 0) {
            try { count = selection.numItems; } catch (eNum) { count = 0; }
        }
        var items = [];
        for (var i = 0; i < count; i++) {
            var item = null;
            try { item = selection[i]; } catch (eItem) { item = null; }
            if (item) items.push(item);
        }
        return items;
    }

    // Linked clips select both their video and audio TrackItems; only video
    // items count as clips. Current releases use "Video"/"Audio" strings,
    // older builds use the numeric TrackItemType enum where VIDEO === 1.
    function isVideoItem(item) {
        var mediaType = null;
        try { mediaType = item.mediaType; } catch (e) { return false; }
        if (typeof mediaType === "string") return mediaType.toLowerCase() === "video";
        if (typeof mediaType === "number") return mediaType === 1;
        return false;
    }

    function videoItemsOf(items) {
        var result = [];
        var seen = {};
        for (var i = 0; i < items.length; i++) {
            if (!isVideoItem(items[i])) continue;
            var nodeId = "";
            try { nodeId = String(items[i].nodeId); } catch (e) { nodeId = ""; }
            if (nodeId && seen[nodeId]) continue;
            if (nodeId) seen[nodeId] = true;
            result.push(items[i]);
        }
        return result;
    }

    function videoClipMap(sequence) {
        var map = {};
        var trackCount = 0;
        try { trackCount = sequence.videoTracks.numTracks; } catch (eCount) { trackCount = 0; }
        for (var t = 0; t < trackCount; t++) {
            var track = sequence.videoTracks[t];
            var clipCount = 0;
            try { clipCount = track.clips.numItems; } catch (eClips) { clipCount = 0; }
            for (var c = 0; c < clipCount; c++) {
                var clip = track.clips[c];
                var nodeId = "";
                try { nodeId = String(clip.nodeId); } catch (eId) { nodeId = ""; }
                if (nodeId) map[nodeId] = { trackIndex: t, clip: clip };
            }
        }
        return map;
    }

    function sequenceBelongsToProject(project, sequence) {
        var targetId = "";
        try { targetId = String(sequence.sequenceID); } catch (eId) { return false; }
        var count = 0;
        try { count = project.sequences.numSequences; } catch (eCount) { return false; }
        for (var i = 0; i < count; i++) {
            var id = "";
            try { id = String(project.sequences[i].sequenceID); } catch (eSeq) { id = ""; }
            if (id === targetId) return true;
        }
        return false;
    }

    function snapshotTimeline(sequence) {
        var snapshot = [];
        var groups = [
            { type: "video", tracks: sequence.videoTracks },
            { type: "audio", tracks: sequence.audioTracks }
        ];
        for (var g = 0; g < groups.length; g++) {
            var trackCount = 0;
            try { trackCount = groups[g].tracks.numTracks; } catch (eCount) { trackCount = 0; }
            for (var t = 0; t < trackCount; t++) {
                var track = groups[g].tracks[t];
                var clipCount = 0;
                try { clipCount = track.clips.numItems; } catch (eClips) { clipCount = 0; }
                for (var c = 0; c < clipCount; c++) {
                    var clip = track.clips[c];
                    var nodeId = "";
                    try { nodeId = String(clip.nodeId); } catch (eId) { nodeId = ""; }
                    snapshot.push({
                        key: groups[g].type + ":" + nodeId,
                        type: groups[g].type,
                        trackIndex: t,
                        nodeId: nodeId,
                        startTicks: String(ticksOf(clip.start)),
                        endTicks: String(ticksOf(clip.end))
                    });
                }
            }
        }
        return snapshot;
    }

    function diffTimeline(before, after) {
        var beforeByKey = {};
        var afterByKey = {};
        var added = [];
        var removed = [];
        var changed = [];
        var i;
        for (i = 0; i < before.length; i++) beforeByKey[before[i].key] = before[i];
        for (i = 0; i < after.length; i++) afterByKey[after[i].key] = after[i];
        for (i = 0; i < after.length; i++) {
            if (!beforeByKey[after[i].key]) added.push(after[i]);
        }
        for (i = 0; i < before.length; i++) {
            var original = before[i];
            var current = afterByKey[original.key];
            if (!current) {
                removed.push(original);
                continue;
            }
            if (original.startTicks !== current.startTicks ||
                original.endTicks !== current.endTicks ||
                String(original.trackIndex) !== String(current.trackIndex)) {
                changed.push(original);
            }
        }
        return { added: added, removed: removed, changed: changed };
    }

    function findProjectItemByNodeId(node, nodeId) {
        var count = 0;
        try { count = node.children.numItems; } catch (eCount) { return null; }
        for (var i = 0; i < count; i++) {
            var child = null;
            try { child = node.children[i]; } catch (eChild) { child = null; }
            if (!child) continue;
            var childId = "";
            try { childId = String(child.nodeId); } catch (eId) { childId = ""; }
            if (childId === String(nodeId)) return child;
            var type = -1;
            try { type = child.type; } catch (eType) { type = -1; }
            if (type === 2) {
                var nested = findProjectItemByNodeId(child, nodeId);
                if (nested) return nested;
            }
        }
        return null;
    }

    function sequenceHasAdjustmentLayer(sequence) {
        var trackCount = 0;
        try { trackCount = sequence.videoTracks.numTracks; } catch (eCount) { trackCount = 0; }
        for (var t = 0; t < trackCount; t++) {
            var track = sequence.videoTracks[t];
            var clipCount = 0;
            try { clipCount = track.clips.numItems; } catch (eClips) { clipCount = 0; }
            for (var c = 0; c < clipCount; c++) {
                var isLayer = false;
                try { isLayer = track.clips[c].isAdjustmentLayer() === true; } catch (eLayer) { isLayer = false; }
                if (isLayer) return true;
            }
        }
        return false;
    }

    function findAdjustmentClip(sequence) {
        var trackCount = 0;
        try { trackCount = sequence.videoTracks.numTracks; } catch (eCount) { trackCount = 0; }
        for (var t = 0; t < trackCount; t++) {
            var track = sequence.videoTracks[t];
            var clipCount = 0;
            try { clipCount = track.clips.numItems; } catch (eClips) { clipCount = 0; }
            for (var c = 0; c < clipCount; c++) {
                var clip = track.clips[c];
                var isLayer = false;
                try { isLayer = clip.isAdjustmentLayer() === true; } catch (eLayer) { isLayer = false; }
                if (isLayer) return clip;
            }
        }
        return null;
    }

    function sequenceIdSet(project) {
        var ids = {};
        var count = 0;
        try { count = project.sequences.numSequences; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            try { ids[String(project.sequences[i].sequenceID)] = true; } catch (eId) {}
        }
        return ids;
    }

    function findImportedDonorSequence(project, existingIds) {
        var fallback = null;
        var count = 0;
        try { count = project.sequences.numSequences; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            var sequence = project.sequences[i];
            var id = "";
            try { id = String(sequence.sequenceID); } catch (eId) { id = ""; }
            if (existingIds[id]) continue;
            if (!sequenceHasAdjustmentLayer(sequence)) continue;
            var name = "";
            try { name = String(sequence.name); } catch (eName) { name = ""; }
            if (name === DONOR_SEQUENCE_NAME) return sequence;
            if (!fallback) fallback = sequence;
        }
        if (fallback) return fallback;
        for (var j = 0; j < count; j++) {
            var existing = project.sequences[j];
            var existingName = "";
            try { existingName = String(existing.name); } catch (eN) { existingName = ""; }
            if (existingName === DONOR_SEQUENCE_NAME && sequenceHasAdjustmentLayer(existing)) return existing;
        }
        return null;
    }

    function resolveDonorTemplate(hint) {
        var candidates = [];
        if (hint) candidates.push(String(hint));
        try {
            var hostFile = new File($.fileName);
            if (hostFile && hostFile.parent) {
                candidates.push(hostFile.parent.fsName + "/" + DONOR_TEMPLATE_NAME);
            }
        } catch (ePath) {}
        for (var i = 0; i < candidates.length; i++) {
            try {
                var file = new File(candidates[i]);
                if (file.exists) return file;
            } catch (eFile) {}
        }
        return null;
    }

    // The donor must use the sequence's frame rate. Otherwise item marks are
    // quantized to the donor rate and cannot reach the clip's exact end on
    // sequences with another rate.
    function rateTicksOf(sequence) {
        var ticks = NaN;
        try { ticks = parseFloat(String(sequence.getSettings().videoFrameRate.ticks)); } catch (e) {}
        if (!isFinite(ticks) || ticks <= 0) ticks = parseFloat(DONOR_BASE_RATE_TICKS);
        return ticks;
    }

    function donorUidFor(rateTicks) {
        var hex = Math.round(rateTicks).toString(16);
        while (hex.length < 12) hex = "0" + hex;
        return "a1c0de00-0000-4000-8000-" + hex;
    }

    function buildDonorFile(template, rateTicks, uid) {
        var text = "";
        try {
            template.encoding = "UTF-8";
            if (!template.open("r")) return null;
            text = template.read();
        } catch (eRead) {
            try { template.close(); } catch (eClose) {}
            return null;
        }
        try { template.close(); } catch (eClose2) {}
        if (!text) return null;

        text = text.split(DONOR_BASE_RATE_TICKS).join(String(Math.round(rateTicks)));
        text = text.split(DONOR_BASE_UID).join(uid);

        // Try the system temp folder first, then the user's AppData folder.
        // Each folder gets a fixed name first and a unique name second, in
        // case a previous copy is still held open or is read-only.
        var folders = donorFolders();
        var baseName = "alc-donor-" + Math.round(rateTicks);
        for (var f = 0; f < folders.length; f++) {
            var names = [baseName + ".prproj", baseName + "-" + (new Date().getTime()) + ".prproj"];
            for (var n = 0; n < names.length; n++) {
                var written = writeTextFile(folders[f] + "/" + names[n], text);
                if (written) return written;
            }
        }
        return null;
    }

    function donorFolders() {
        var list = [];
        try { if (Folder.temp && Folder.temp.exists) list.push(Folder.temp.fsName); } catch (eTemp) {}
        try {
            var appData = new Folder(Folder.userData.fsName + "/openClick");
            if (!appData.exists) appData.create();
            if (appData.exists) list.push(appData.fsName);
        } catch (eAppData) {}
        try {
            var myDocs = new Folder(Folder.myDocuments.fsName + "/openClick");
            if (!myDocs.exists) myDocs.create();
            if (myDocs.exists) list.push(myDocs.fsName);
        } catch (eDocs) {}
        return list;
    }

    function writeTextFile(path, text) {
        var outFile = null;
        try {
            outFile = new File(path);
            outFile.encoding = "UTF-8";
            if (!outFile.open("w")) return null;
            var ok = outFile.write(text);
            outFile.close();
            if (ok === false || !outFile.exists || outFile.length <= 0) return null;
            return outFile;
        } catch (eWrite) {
            try { if (outFile) outFile.close(); } catch (eClose) {}
            return null;
        }
    }

    function findSequenceByUid(project, uid) {
        var count = 0;
        try { count = project.sequences.numSequences; } catch (e) { return null; }
        for (var i = 0; i < count; i++) {
            var id = "";
            try { id = String(project.sequences[i].sequenceID); } catch (e2) { id = ""; }
            if (id === uid) return project.sequences[i];
        }
        return null;
    }

    function acquireAdjustmentItem(project, sequence, donorHint) {
        var cache = state();
        var projectPath = normalizePath(project.path);
        var rateTicks = rateTicksOf(sequence);
        var uid = donorUidFor(rateTicks);

        if (cache.projectPath === projectPath && cache.adjustmentNodeId &&
            String(cache.rateTicks) === String(rateTicks)) {
            var cached = findProjectItemByNodeId(project.rootItem, cache.adjustmentNodeId);
            if (cached) return { ok: true, item: cached, importedSequenceItem: null };
            cache.adjustmentNodeId = "";
        }

        var donorSequence = findSequenceByUid(project, uid);
        if (donorSequence && !sequenceHasAdjustmentLayer(donorSequence)) {
            donorSequence = null;
        }

        var imported = false;
        if (!donorSequence) {
            var template = resolveDonorTemplate(donorHint);
            if (!template) {
                return { ok: false, code: "DONOR_MISSING", message: "The adjustment layer source is missing. Reinstall the extension." };
            }
            var donorFile = buildDonorFile(template, rateTicks, uid);
            if (!donorFile) {
                return { ok: false, code: "DONOR_IMPORT_FAILED", message: "Could not load the layer source. Reinstall the extension and retry." };
            }

            var existingIds = sequenceIdSet(project);
            try {
                imported = project.importSequences(donorFile.fsName, [uid]);
            } catch (eImport) {
                return { ok: false, code: "DONOR_IMPORT_FAILED", message: "Could not load the layer source. Reinstall the extension and retry." };
            }

            donorSequence = findImportedDonorSequence(project, existingIds);
            if (!donorSequence) {
                return { ok: false, code: "DONOR_SEQUENCE_MISSING", message: "Could not prepare the adjustment layer. Nothing was changed." };
            }
        }

        var layerClip = findAdjustmentClip(donorSequence);
        if (!layerClip) {
            return { ok: false, code: "NO_ADJUSTMENT_ITEM", message: "The layer source is unavailable. Reinstall the extension." };
        }

        var item = null;
        try { item = layerClip.projectItem; } catch (eItem) { item = null; }
        if (!item) {
            var itemNodeId = "";
            try { itemNodeId = String(layerClip.projectItem.nodeId); } catch (eNode) { itemNodeId = ""; }
            if (itemNodeId) item = findProjectItemByNodeId(project.rootItem, itemNodeId);
        }
        if (!item) {
            return { ok: false, code: "NO_ADJUSTMENT_ITEM", message: "The layer source is unavailable. Reinstall the extension." };
        }

        var sequenceItem = null;
        try { sequenceItem = donorSequence.projectItem; } catch (eSeqItem) { sequenceItem = null; }

        cache.projectPath = projectPath;
        cache.rateTicks = String(rateTicks);
        cache.adjustmentNodeId = String(item.nodeId);

        return {
            ok: true,
            item: item,
            importedSequenceItem: imported ? sequenceItem : null
        };
    }

    function deleteProjectItem(project, item) {
        if (!item) return false;
        var holder = null;
        try {
            holder = project.rootItem.createBin("al-temp-" + (new Date().getTime()));
        } catch (eCreate) {
            holder = null;
        }
        if (!holder) return false;
        var moved = false;
        try {
            item.moveBin(holder);
            moved = true;
        } catch (eMove) {
            try { holder.deleteBin(); } catch (eCleanup) {}
            return false;
        }
        if (!moved) return false;
        try {
            holder.deleteBin();
            return true;
        } catch (eDelete) {
            return false;
        }
    }

    function addVideoTrack(sequence) {
        var before = 0;
        try { before = sequence.videoTracks.numTracks; } catch (eBefore) { return false; }
        try {
            app.enableQE();
            var qeSequence = qe.project.getActiveSequence();
            if (!qeSequence) return false;
            var audioCount = 0;
            try { audioCount = sequence.audioTracks.numTracks; } catch (eAudio) { audioCount = 0; }
            qeSequence.addTracks(1, before, 0, 1, audioCount, 0, 0);
        } catch (eAdd) {
            return false;
        }
        var after = 0;
        try { after = sequence.videoTracks.numTracks; } catch (eAfter) { return false; }
        return after > before;
    }

    function findInsertedLayer(track, startTicks, endTicks) {
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { return null; }
        for (var i = 0; i < count; i++) {
            var clip = track.clips[i];
            var isLayer = false;
            try { isLayer = clip.isAdjustmentLayer() === true; } catch (eLayer) { isLayer = false; }
            if (!isLayer) continue;
            var clipStart = ticksOf(clip.start);
            var clipEnd = ticksOf(clip.end);
            if (clipStart === startTicks && clipEnd === endTicks) return clip;
        }
        return null;
    }

    function rollbackLayer(track, startTicks, endTicks) {
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { return false; }
        for (var i = 0; i < count; i++) {
            var clip = track.clips[i];
            var isLayer = false;
            try { isLayer = clip.isAdjustmentLayer() === true; } catch (eLayer) { isLayer = false; }
            if (!isLayer) continue;
            var clipStart = ticksOf(clip.start);
            var clipEnd = ticksOf(clip.end);
            if (clipStart < endTicks && clipEnd > startTicks) {
                try {
                    clip.remove(0, 0);
                    return true;
                } catch (eRemove) {
                    return false;
                }
            }
        }
        return false;
    }

    // QE track items interleave empty gaps, so the inserted clip has to be
    // found by type and exact tick range rather than by a fixed index.
    function findQeClipItem(trackIndex, startTicks, endTicks) {
        if (typeof qe === "undefined" || !qe) return null;
        var qeSequence = null;
        try { qeSequence = qe.project.getActiveSequence(); } catch (eSeq) { qeSequence = null; }
        if (!qeSequence) return null;
        var qeTrack = null;
        try { qeTrack = qeSequence.getVideoTrackAt(trackIndex); } catch (eTrack) { qeTrack = null; }
        if (!qeTrack) return null;

        var count = 0;
        try { count = qeTrack.numItems; } catch (eCount) { return null; }
        for (var i = 0; i < count; i++) {
            var item = null;
            try { item = qeTrack.getItemAt(i); } catch (eItem) { item = null; }
            if (!item) continue;
            var type = "";
            try { type = String(item.type); } catch (eType) { continue; }
            if (type !== "Clip") continue;
            var itemStart = NaN;
            var itemEnd = NaN;
            try {
                itemStart = ticksOf(item.start);
                itemEnd = ticksOf(item.end);
            } catch (eTime) {
                continue;
            }
            if (itemStart === startTicks && itemEnd === endTicks) return item;
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Preset support
    //
    // The preset file (Transform(openClick).prfpset) is read every time the
    // button is clicked, so whatever is saved in that file is what every new
    // adjustment layer receives. The file stores the effect's match name
    // (AE.ADBE Geometry2 = the current Transform effect) and every parameter
    // value. Premiere has two effects called "Transform" (the current one and
    // the legacy AE.ADBE Geometry), so the effect is verified by match name,
    // not by display name.
    // ---------------------------------------------------------------------

    var PRESET_FILE_NAME = "Transform(openClick).prfpset";
    var BASE_COMPONENTS = { "AE.ADBE Opacity": true, "AE.ADBE Motion": true };

    // Labels used when the preset stores a parameter without a name (Premiere
    // omits names for checkbox parameters). Keyed by match name, then
    // ParameterID. Only used when index matching is not possible.
    var UNNAMED_PARAM_LABELS = {
        "AE.ADBE Geometry2": { "4": "scale width", "9": "use composition's shutter angle", "11": "uniform scale" },
        "AE.ADBE Geometry": { "4": "scale width", "9": "use composition's shutter angle", "11": "uniform scale" }
    };

    function xmlText(block, tag) {
        var match = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">").exec(block);
        if (!match) return null;
        return match[1]
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&");
    }

    function objectBlock(text, objectId) {
        var re = new RegExp("<(\\w+) ObjectID=\"" + objectId + "\"[^>]*>([\\s\\S]*?)</\\1>");
        var match = re.exec(text);
        return match ? match[2] : null;
    }

    function parsePresetValue(raw) {
        var value = String(raw);
        if (value === "true") return true;
        if (value === "false") return false;
        if (value.indexOf(":") >= 0) {
            var parts = value.split(":");
            var point = [];
            for (var i = 0; i < parts.length; i++) point.push(parseFloat(parts[i]));
            return point;
        }
        var number = parseFloat(value);
        return isFinite(number) ? number : null;
    }

    function normalizeLabel(name) {
        return String(name || "")
            .replace(/[\u2018\u2019\u02BC`]/g, "'")
            .replace(/^\s+|\s+$/g, "")
            .toLowerCase();
    }

    function resolvePresetFile(hint) {
        var candidates = [];
        if (hint) candidates.push(String(hint));
        try {
            var hostFile = new File($.fileName);
            if (hostFile && hostFile.parent) {
                candidates.push(hostFile.parent.parent.fsName + "/presets/" + PRESET_FILE_NAME);
                candidates.push(hostFile.parent.fsName + "/" + PRESET_FILE_NAME);
            }
        } catch (ePath) {}
        for (var i = 0; i < candidates.length; i++) {
            try {
                var file = new File(candidates[i]);
                if (file.exists) return file;
            } catch (eFile) {}
        }
        return null;
    }

    function loadPreset(hint) {
        var file = resolvePresetFile(hint);
        if (!file) return null;
        var modified = "";
        try { modified = String(file.modified.getTime()); } catch (eModified) { modified = ""; }
        var text = "";
        try {
            file.encoding = "UTF-8";
            if (!file.open("r")) return null;
            text = file.read();
        } catch (eRead) {
            try { file.close(); } catch (eClose) {}
            return null;
        }
        try { file.close(); } catch (eClose2) {}
        if (!text) return null;

        var matchName = xmlText(text, "FilterMatchName");
        if (!matchName) return null;

        var componentMatch = /<VideoFilterComponent [^>]*>([\s\S]*?)<\/VideoFilterComponent>/.exec(text);
        if (!componentMatch) return null;
        var componentBlock = componentMatch[1];
        var displayName = xmlText(componentBlock, "DisplayName") || "";

        var params = [];
        var paramRe = /<Param Index="(\d+)" ObjectRef="(\d+)"\/>/g;
        var paramMatch;
        while ((paramMatch = paramRe.exec(componentBlock)) !== null) {
            var block = objectBlock(text, paramMatch[2]);
            if (!block) continue;
            var startKey = xmlText(block, "StartKeyframe");
            if (startKey === null) continue;
            var fields = startKey.split(",");
            if (fields.length < 2) continue;
            var parameterId = xmlText(block, "ParameterID") || "";
            var name = xmlText(block, "Name");
            if (name === null || normalizeLabel(name) === "") {
                var labels = UNNAMED_PARAM_LABELS[matchName];
                name = (labels && labels[parameterId]) || "";
            }
            params.push({
                index: parseInt(paramMatch[1], 10),
                id: parameterId,
                name: name,
                value: parsePresetValue(fields[1])
            });
        }
        params.sort(function (a, b) { return a.index - b.index; });
        if (params.length === 0) return null;

        return { matchName: matchName, displayName: displayName, params: params, modified: modified };
    }

    function valuesEqual(a, b) {
        if (a === null || a === undefined || b === null || b === undefined) return false;
        if (typeof a === "boolean" || typeof b === "boolean") {
            return String(a) === String(b);
        }
        if (a instanceof Array || b instanceof Array) {
            if (!(a instanceof Array) || !(b instanceof Array)) return false;
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {
                if (Math.abs(Number(a[i]) - Number(b[i])) > 0.0001) return false;
            }
            return true;
        }
        return Math.abs(Number(a) - Number(b)) <= 0.0001;
    }

    // The effect that the last addVideoEffect call created: the fresh layer
    // only carries Opacity and Motion, so it is the last other component.
    function findAddedComponent(track, startTicks, endTicks) {
        var clip = findInsertedLayer(track, startTicks, endTicks);
        if (!clip) return null;
        var components = null;
        try { components = clip.components; } catch (eComponents) { return null; }
        if (!components) return null;
        var count = 0;
        try { count = components.numItems; } catch (eCount) { return null; }
        for (var i = count - 1; i >= 0; i--) {
            var component = components[i];
            var matchName = "";
            try { matchName = String(component.matchName); } catch (eMatch) { matchName = ""; }
            if (!BASE_COMPONENTS[matchName]) return { component: component, matchName: matchName };
        }
        return null;
    }

    function presetEffectCandidates(preset) {
        var names = [];
        var seen = {};
        function add(name) {
            if (!name || seen[name]) return;
            seen[name] = true;
            names.push(name);
        }
        add(preset.matchName);
        add(preset.matchName.replace(/^AE\./, ""));
        add(preset.displayName);
        add("Transform");

        var candidates = [];
        for (var i = 0; i < names.length; i++) {
            var effect = null;
            try { effect = qe.project.getVideoEffectByName(names[i]); } catch (eEffect) { effect = null; }
            if (!effect) continue;
            // Some QE builds expose the match name on the effect object; skip
            // ones that are clearly the wrong variant before touching the clip.
            var reported = "";
            try { reported = String(effect.matchName || ""); } catch (eReported) { reported = ""; }
            if (reported && reported !== preset.matchName &&
                ("AE." + reported) !== preset.matchName) {
                candidates.push({ effect: effect, lookup: names[i], preferred: false });
                continue;
            }
            candidates.push({ effect: effect, lookup: names[i], preferred: true });
        }
        candidates.sort(function (a, b) { return (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0); });
        return candidates;
    }

    function writePresetValues(component, preset) {
        var properties = null;
        try { properties = component.properties; } catch (eProps) { return false; }
        if (!properties) return false;
        var count = 0;
        try { count = properties.numItems; } catch (eCount) { return false; }

        var list = [];
        for (var p = 0; p < count; p++) list.push(properties[p]);

        // Same parameter count: map by position (works in every UI language).
        // Otherwise fall back to matching by name.
        var byIndex = count === preset.params.length;
        var byName = {};
        if (!byIndex) {
            for (var q = 0; q < list.length; q++) {
                var label = "";
                try { label = normalizeLabel(list[q].displayName); } catch (eLabel) { label = ""; }
                if (label && !byName[label]) byName[label] = list[q];
            }
        }

        var applied = 0;
        for (var i = 0; i < preset.params.length; i++) {
            var wanted = preset.params[i];
            if (wanted.value === null) continue;
            var property = byIndex ? list[i] : byName[normalizeLabel(wanted.name)];
            if (!property) continue;

            var current = null;
            try { current = property.getValue(); } catch (eGet) { current = null; }
            if (!valuesEqual(current, wanted.value)) {
                try {
                    property.setValue(wanted.value, true);
                } catch (eSet) {
                    return false;
                }
                try { current = property.getValue(); } catch (eGet2) { current = null; }
                if (!valuesEqual(current, wanted.value)) return false;
            }
            applied++;
        }
        return applied > 0;
    }

    function propertyCount(component) {
        var count = 0;
        try { count = component.properties.numItems; } catch (eCount) { return 0; }
        return count;
    }

    // Adds the preset's effect to the freshly placed layer and writes every
    // parameter stored in the preset. Premiere has two effects called
    // "Transform" (the current AE.ADBE Geometry2 and the legacy
    // AE.ADBE Geometry) and its QE lookup only returns the legacy one. The two
    // expose the same controls, so a legacy variant with the preset's exact
    // parameter set is accepted in place instead of deleting and re-adding the
    // layer, which made the timeline flicker. Returns { ok, exact } where exact
    // means the effect match name equals the preset's.
    function applyLayerPreset(preset, trackIndex, track, startTicks, endTicks, replaceLayer) {
        try { app.enableQE(); } catch (eEnable) { return { ok: false }; }

        var candidates = presetEffectCandidates(preset);
        if (candidates.length === 0) return { ok: false };

        // Remember which lookup produced a working effect so later clicks go
        // straight to it instead of probing every name again.
        var cache = state();
        var cacheKey = preset.matchName + "|" + preset.params.length + "|" + preset.modified;
        var cachedLookup = cache.effectCacheKey === cacheKey ? cache.effectLookup : "";
        if (cachedLookup) {
            var ordered = [];
            for (var o = 0; o < candidates.length; o++) {
                if (candidates[o].lookup === cachedLookup) ordered.unshift(candidates[o]);
                else ordered.push(candidates[o]);
            }
            candidates = ordered;
        }

        for (var c = 0; c < candidates.length; c++) {
            var qeItem = findQeClipItem(trackIndex, startTicks, endTicks);
            if (!qeItem) return { ok: false };
            try {
                qeItem.addVideoEffect(candidates[c].effect);
            } catch (eAdd) {
                continue;
            }

            var added = findAddedComponent(track, startTicks, endTicks);
            if (!added) {
                if (!replaceLayer()) return { ok: false };
                continue;
            }

            var exact = added.matchName === preset.matchName;
            var sameEffect = /Geometry/.test(added.matchName) && /Geometry/.test(preset.matchName);
            var sameControls = sameEffect && propertyCount(added.component) === preset.params.length;
            if (!exact && !sameControls) {
                if (!replaceLayer()) return { ok: false };
                continue;
            }

            if (!writePresetValues(added.component, preset)) {
                if (!replaceLayer()) return { ok: false };
                continue;
            }
            cache.effectCacheKey = cacheKey;
            cache.effectLookup = candidates[c].lookup;
            return { ok: true, exact: exact };
        }
        return { ok: false };
    }

    // A clip collides only when its range actually intersects the target range.
    // Ranges are half-open, so a clip ending exactly at startTicks (or starting
    // exactly at endTicks) does not block the insertion.
    function isTrackFree(track, startTicks, endTicks) {
        var locked = false;
        try { locked = track.isLocked() === true; } catch (eLocked) { locked = false; }
        if (locked) return false;

        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            var clipStart = ticksOf(track.clips[i].start);
            var clipEnd = ticksOf(track.clips[i].end);
            if (clipStart < endTicks && clipEnd > startTicks) return false;
        }
        return true;
    }

    function createAdjustmentLayer(donorHint, combined, presetHint) {
        var insertedLayers = [];
        var trackAdded = false;
        var usedLegacyTransform = false;

        function restoreInserted() {
            var restored = true;
            for (var k = insertedLayers.length - 1; k >= 0; k--) {
                var record = insertedLayers[k];
                if (!rollbackLayer(record.track, record.startTicks, record.endTicks)) restored = false;
            }
            insertedLayers = [];
            return restored;
        }

        function fail(code, base) {
            var restored = restoreInserted();
            if (!restored) return response(false, code, base + " Check the timeline.");
            if (trackAdded) return response(false, code, base + " An empty video track was added.");
            return response(false, code, base + " Nothing was changed.");
        }

        try {
            var project = null;
            try { project = app.project; } catch (eProject) { project = null; }
            if (!project) {
                return response(false, "NO_PROJECT", "Open a project first.");
            }

            var version = 0;
            try { version = parseFloat(app.version); } catch (eVersion) { version = 0; }
            if (version && version < 22) {
                return response(false, "UNSUPPORTED_VERSION", "This version of Premiere Pro is not supported.");
            }

            var sequence = null;
            try { sequence = project.activeSequence; } catch (eSequence) { sequence = null; }
            if (!sequence || !sequenceBelongsToProject(project, sequence)) {
                return response(false, "NO_ACTIVE_SEQUENCE", "Open a sequence first.");
            }

            var selection = selectionItems(sequence);
            if (selection.length === 0) {
                return response(false, "NO_SELECTION", "Please select a video clip first.");
            }

            var videoSelection = videoItemsOf(selection);
            if (videoSelection.length === 0) {
                return response(false, "NOT_VIDEO_CLIP", "Select a video clip, not an audio or other item.");
            }

            var map = videoClipMap(sequence);
            var jobs = [];
            var seen = {};
            for (var s = 0; s < videoSelection.length; s++) {
                var selectedNodeId = "";
                try { selectedNodeId = String(videoSelection[s].nodeId); } catch (eSelectedId) { selectedNodeId = ""; }
                if (selectedNodeId && seen[selectedNodeId]) continue;
                if (selectedNodeId) seen[selectedNodeId] = true;

                var entry = map[selectedNodeId];
                if (!entry) {
                    return response(false, "NOT_VIDEO_CLIP", "Select video clips from the timeline and try again.");
                }

                var startTicks = ticksOf(entry.clip.start);
                var endTicks = ticksOf(entry.clip.end);
                var durationTicks = endTicks - startTicks;
                if (!isFinite(startTicks) || !isFinite(endTicks) || durationTicks <= 0) {
                    return response(false, "UNREADABLE_TIMING", "Could not read a selected clip's timing. Nothing was changed.");
                }

                jobs.push({
                    trackIndex: entry.trackIndex,
                    startTicks: startTicks,
                    endTicks: endTicks,
                    durationTicks: durationTicks
                });
            }
            if (jobs.length === 0) {
                return response(false, "NOT_VIDEO_CLIP", "Select a video clip, not an audio or other item.");
            }

            // Insert lower tracks first so every later search sees the layers
            // already placed and can step above them instead of overwriting.
            jobs.sort(function (a, b) {
                if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
                return a.startTicks - b.startTicks;
            });

            // Shift+click asks for one layer covering every selected clip. It
            // must sit above the highest selected track so it affects them all.
            var targets;
            if (combined && jobs.length > 1) {
                var spanStart = jobs[0].startTicks;
                var spanEnd = jobs[0].endTicks;
                for (var u = 1; u < jobs.length; u++) {
                    if (jobs[u].startTicks < spanStart) spanStart = jobs[u].startTicks;
                    if (jobs[u].endTicks > spanEnd) spanEnd = jobs[u].endTicks;
                }
                targets = [{
                    trackIndex: jobs[jobs.length - 1].trackIndex,
                    startTicks: spanStart,
                    endTicks: spanEnd,
                    durationTicks: spanEnd - spanStart
                }];
            } else {
                targets = jobs;
            }

            var preset = loadPreset(presetHint);
            if (!preset) {
                return response(false, "PRESET_MISSING", "The Transform(openClick) preset file is missing or unreadable. Nothing was changed.");
            }

            var acquired = acquireAdjustmentItem(project, sequence, donorHint);
            if (!acquired.ok) {
                return response(false, acquired.code, acquired.message);
            }
            var item = acquired.item;

            for (var j = 0; j < targets.length; j++) {
                var job = targets[j];
                var durationSeconds = job.durationTicks / TICKS_PER_SECOND;
                try {
                    item.setInPoint(MARK_EPSILON, 1);
                    item.setOutPoint(durationSeconds + MARK_EPSILON, 1);
                } catch (eMarks) {
                    return fail("MARK_FAILED", "Could not prepare an adjustment layer.");
                }

                var markIn = NaN;
                var markOut = NaN;
                try {
                    markIn = ticksOf(item.getInPoint(1));
                    markOut = ticksOf(item.getOutPoint(1));
                } catch (eReadMarks) {
                    markIn = NaN;
                    markOut = NaN;
                }
                if (markIn !== 0 || markOut !== job.durationTicks) {
                    return fail("MARK_MISMATCH", "Could not match a layer's timing to its clip.");
                }

                var videoTrackCount = 0;
                try { videoTrackCount = sequence.videoTracks.numTracks; } catch (eTrackCount) { videoTrackCount = 0; }

                var targetTrack = null;
                for (var targetIndex = job.trackIndex + 1; ; targetIndex++) {
                    if (targetIndex >= videoTrackCount) {
                        if (!addVideoTrack(sequence)) {
                            return fail("TRACK_CREATE_FAILED", "Could not add a video track above a selected clip.");
                        }
                        trackAdded = true;
                        try { videoTrackCount = sequence.videoTracks.numTracks; } catch (eAfterAdd) { videoTrackCount = 0; }
                        if (targetIndex >= videoTrackCount) {
                            return fail("TRACK_CREATE_FAILED", "Could not add a video track above a selected clip.");
                        }
                    }

                    var candidate = sequence.videoTracks[targetIndex];
                    if (isTrackFree(candidate, job.startTicks, job.endTicks)) {
                        targetTrack = candidate;
                        break;
                    }
                }

                var placeLayer = (function (track, startTicks, endTicks) {
                    return function () {
                        var before = snapshotTimeline(sequence);
                        var insertTime = new Time();
                        insertTime.ticks = String(startTicks);
                        try {
                            track.overwriteClip(item, insertTime);
                        } catch (eInsert) {
                            return false;
                        }
                        var after = snapshotTimeline(sequence);
                        var difference = diffTimeline(before, after);
                        var layer = findInsertedLayer(track, startTicks, endTicks);
                        var verified = !!layer &&
                            difference.removed.length === 0 &&
                            difference.changed.length === 0 &&
                            difference.added.length === 1;
                        if (!verified) {
                            rollbackLayer(track, startTicks, endTicks);
                            return false;
                        }
                        return true;
                    };
                })(targetTrack, job.startTicks, job.endTicks);

                var replaceLayer = (function (track, startTicks, endTicks) {
                    return function () {
                        if (!rollbackLayer(track, startTicks, endTicks)) return false;
                        return placeLayer();
                    };
                })(targetTrack, job.startTicks, job.endTicks);

                if (!placeLayer()) {
                    return fail("PLACEMENT_FAILED", "An adjustment layer could not be placed.");
                }

                var presetResult = applyLayerPreset(preset, targetIndex, targetTrack, job.startTicks, job.endTicks, replaceLayer);
                if (!presetResult.ok) {
                    rollbackLayer(targetTrack, job.startTicks, job.endTicks);
                    return fail("PRESET_FAILED", "Could not apply the Transform(openClick) preset.");
                }
                if (!presetResult.exact) usedLegacyTransform = true;

                insertedLayers.push({
                    track: targetTrack,
                    startTicks: job.startTicks,
                    endTicks: job.endTicks
                });
            }

            if (acquired.importedSequenceItem) {
                deleteProjectItem(project, acquired.importedSequenceItem);
            }

            var note = usedLegacyTransform
                ? " (preset values applied, but Premiere only offered the legacy Transform effect)"
                : "";
            if (combined && jobs.length > 1) {
                return response(true, "OK", "Adjustment layer added across selected clips." + note);
            }
            if (jobs.length === 1) {
                return response(true, "OK", "Adjustment layer added." + note);
            }
            return response(true, "OK", "Adjustment layers added." + note);
        } catch (e) {
            if (!restoreInserted()) {
                return response(false, "UNEXPECTED_ERROR", "An unexpected error occurred. Check the timeline.");
            }
            if (trackAdded) {
                return response(false, "UNEXPECTED_ERROR", "An unexpected error occurred. An empty video track was added.");
            }
            return response(false, "UNEXPECTED_ERROR", "An unexpected error occurred. Nothing was changed.");
        }
    }

    var OpenClick = { createAdjustmentLayer: createAdjustmentLayer };
    $.global.OpenClick = OpenClick;
})();
