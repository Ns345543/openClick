(function () {
    var TICKS_PER_SECOND = 254016000000;
    var DONOR_TEMPLATE_NAME = "OpenClickLayerDonor.xml";
    var DONOR_BASE_RATE_TICKS = "4233600000";
    var DONOR_BASE_UID = "3c4a394b-8896-4840-8515-391db20b5da4";
    var DONOR_SEQUENCE_NAME = "openClick Layer Donor";
    var MARK_EPSILON = 0.001;
    // ProjectItem color labels: 7 = Mango. Every layer is placed from the same
    // donor item, so labelling it labels every adjustment layer.
    var LAYER_LABEL_MANGO = 7;

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
                donorSequenceId: "",
                adjustmentItem: null,
                effectCacheKey: "",
                effectLookup: "",
                presetKey: "",
                preset: null
            };
        }
        return $.global.__ALC_STATE__;
    }

    function invalidateAdjustmentCache() {
        var cache = state();
        cache.adjustmentNodeId = "";
        cache.donorSequenceId = "";
        cache.adjustmentItem = null;
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

    // Only the selected clips' tracks are needed. Scanning every video clip in
    // the timeline cost more the larger the project was, so this stops as soon
    // as each selected clip has been located.
    function selectedVideoMap(sequence, selectedItems) {
        var wanted = {};
        var ids = [];
        var i;
        for (i = 0; i < selectedItems.length; i++) {
            var selectedId = "";
            try { selectedId = String(selectedItems[i].nodeId); } catch (eSelectedId) { selectedId = ""; }
            if (!selectedId || wanted[selectedId]) continue;
            wanted[selectedId] = true;
            ids.push(selectedId);
        }

        var map = {};
        var remaining = ids.length;
        var trackCount = 0;
        try { trackCount = sequence.videoTracks.numTracks; } catch (eCount) { trackCount = 0; }
        for (var t = 0; t < trackCount && remaining > 0; t++) {
            var track = sequence.videoTracks[t];
            var clipCount = 0;
            try { clipCount = track.clips.numItems; } catch (eClips) { clipCount = 0; }
            for (var c = 0; c < clipCount && remaining > 0; c++) {
                var clip = track.clips[c];
                var nodeId = "";
                try { nodeId = String(clip.nodeId); } catch (eId) { nodeId = ""; }
                if (!nodeId || !wanted[nodeId] || map[nodeId]) continue;
                map[nodeId] = { trackIndex: t, clip: clip };
                remaining--;
            }
        }
        return map;
    }

    // project.activeSequence already belongs to this project, so scanning every
    // sequence only added cost on large projects. Readability is enough.
    function activeSequenceReadable(sequence) {
        if (!sequence) return false;
        var id = "";
        try { id = String(sequence.sequenceID); } catch (eId) { return false; }
        if (!id) return false;
        try { sequence.videoTracks.numTracks; } catch (eTracks) { return false; }
        return true;
    }

    function findSequenceById(project, sequenceId) {
        if (!sequenceId) return null;
        var count = 0;
        try { count = project.sequences.numSequences; } catch (eCount) { return null; }
        for (var i = 0; i < count; i++) {
            var sequence = null;
            try { sequence = project.sequences[i]; } catch (eSeq) { sequence = null; }
            var id = "";
            try { id = String(sequence.sequenceID); } catch (eId) { id = ""; }
            if (id === String(sequenceId)) return sequence;
        }
        return null;
    }

    // A single track's clip inventory. Verifying a placement only needs the
    // track that was written to; scanning the whole timeline twice per layer is
    // what made clicks slow in large projects.
    function snapshotTrackClips(track, type, trackIndex, withItemId) {
        var snapshot = [];
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { count = 0; }
        for (var c = 0; c < count; c++) {
            var clip = track.clips[c];
            var nodeId = "";
            try { nodeId = String(clip.nodeId); } catch (eId) { nodeId = ""; }
            var itemNodeId = "";
            if (withItemId) {
                try {
                    var projectItem = clip.projectItem;
                    if (projectItem) itemNodeId = String(projectItem.nodeId);
                } catch (eItem) { itemNodeId = ""; }
            }
            snapshot.push({
                key: type + ":" + nodeId,
                type: type,
                trackIndex: trackIndex,
                nodeId: nodeId,
                projectItemNodeId: itemNodeId,
                startTicks: String(ticksOf(clip.start)),
                endTicks: String(ticksOf(clip.end))
            });
        }
        return snapshot;
    }

    // Every clip property read crosses into Premiere, so a click that touched a
    // busy track used to pay for several full scans of it. One inventory per
    // video track per click is built here and kept up to date as layers are
    // inserted, so collision checks and placement verification read plain
    // numbers instead of the timeline.
    function buildTimelineIndex(sequence) {
        return { sequence: sequence, tracks: [] };
    }

    function indexTrack(index, trackIndex) {
        if (index.tracks[trackIndex]) return index.tracks[trackIndex];
        var track = null;
        try { track = index.sequence.videoTracks[trackIndex]; } catch (eTrack) { track = null; }
        if (!track) {
            index.tracks[trackIndex] = null;
            return null;
        }
        var ranges = [];
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            var clip = null;
            try { clip = track.clips[i]; } catch (eClip) { clip = null; }
            if (!clip) continue;
            var start = NaN;
            var end = NaN;
            try {
                start = ticksOf(clip.start);
                end = ticksOf(clip.end);
            } catch (eTime) {
                continue;
            }
            if (!isFinite(start) || !isFinite(end)) continue;
            ranges.push({ start: start, end: end });
        }
        var entry = { track: track, ranges: ranges };
        index.tracks[trackIndex] = entry;
        return entry;
    }

    function indexInsert(index, trackIndex, startTicks, endTicks) {
        var entry = index.tracks[trackIndex];
        if (!entry) return;
        var at = 0;
        while (at < entry.ranges.length && entry.ranges[at].start < startTicks) at++;
        entry.ranges.splice(at, 0, { start: startTicks, end: endTicks });
    }

    function dropTrackIndex(index, trackIndex) {
        if (index && typeof trackIndex === "number") index.tracks[trackIndex] = null;
    }

    function getClipAt(track, position) {
        if (position < 0) return null;
        try { return track.clips[position]; } catch (e) { return null; }
    }

    // Clips come back in timeline order, so the inserted layer sits at the
    // number of earlier starts. The guess is only a shortcut: if the clip there
    // is not an exact range match, fall back to a linear scan.
    function locateLayerAt(track, startTicks, endTicks, guess) {
        if (typeof guess === "number" && guess >= 0) {
            var guessed = getClipAt(track, guess);
            if (guessed && clipRangeMatches(guessed, startTicks, endTicks)) return guess;
        }
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            var clip = getClipAt(track, i);
            if (clip && clipRangeMatches(clip, startTicks, endTicks)) return i;
        }
        return -1;
    }

    function clipRangeMatches(clip, startTicks, endTicks) {
        var start = NaN;
        var end = NaN;
        try {
            start = ticksOf(clip.start);
            end = ticksOf(clip.end);
        } catch (e) {
            return false;
        }
        return start === startTicks && end === endTicks;
    }

    function appendTrackSnapshot(snapshot, track, type, trackIndex) {
        var part = snapshotTrackClips(track, type, trackIndex, true);
        for (var k = 0; k < part.length; k++) snapshot.push(part[k]);
    }

    function snapshotTracks(sequence, videoIndices, audioIndices) {
        var snapshot = [];
        var seen = {};
        var i;
        for (i = 0; i < videoIndices.length; i++) {
            var videoIndex = videoIndices[i];
            if (seen["v" + videoIndex]) continue;
            seen["v" + videoIndex] = true;
            var videoTrack = null;
            try { videoTrack = sequence.videoTracks[videoIndex]; } catch (eVideo) { videoTrack = null; }
            if (!videoTrack) continue;
            appendTrackSnapshot(snapshot, videoTrack, "video", videoIndex);
        }
        for (i = 0; i < audioIndices.length; i++) {
            var audioIndex = audioIndices[i];
            if (seen["a" + audioIndex]) continue;
            seen["a" + audioIndex] = true;
            var audioTrack = null;
            try { audioTrack = sequence.audioTracks[audioIndex]; } catch (eAudio) { audioTrack = null; }
            if (!audioTrack) continue;
            appendTrackSnapshot(snapshot, audioTrack, "audio", audioIndex);
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

    function findProjectItemInSequences(project, nodeId) {
        var count = 0;
        try { count = project.sequences.numSequences; } catch (eCount) { return null; }
        for (var i = 0; i < count; i++) {
            var sequence = null;
            try { sequence = project.sequences[i]; } catch (eSeq) { sequence = null; }
            var item = null;
            try { item = sequence.projectItem; } catch (eItem) { item = null; }
            var id = "";
            try { id = String(item.nodeId); } catch (eId) { id = ""; }
            if (id && id === String(nodeId)) return item;
        }
        return null;
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

    function labelAdjustmentItem(item) {
        try { item.setColorLabel(LAYER_LABEL_MANGO); } catch (eLabel) {}
        return item;
    }

    function acquireAdjustmentItem(project, sequence, donorHint) {
        var cache = state();
        var projectPath = normalizePath(project.path);
        var rateTicks = rateTicksOf(sequence);
        var uid = donorUidFor(rateTicks);

        if (cache.projectPath === projectPath &&
            String(cache.rateTicks) === String(rateTicks)) {
            // Reuse the cached item handle: walking the project tree on every
            // click is expensive once a project holds thousands of items.
            var cachedItem = cache.adjustmentItem;
            var cachedId = "";
            if (cachedItem) {
                try { cachedId = String(cachedItem.nodeId); } catch (eCachedId) { cachedId = ""; }
            }
            if (cachedItem && cachedId && cachedId === String(cache.adjustmentNodeId)) {
                return { ok: true, item: labelAdjustmentItem(cachedItem), importedSequenceItem: null };
            }
            // The donor sequence holds exactly one layer clip, so re-reading it
            // is a cheap, reliable way to recover a lost handle.
            var cachedSequence = findSequenceById(project, cache.donorSequenceId);
            if (cachedSequence) {
                var cachedLayer = findAdjustmentClip(cachedSequence);
                if (cachedLayer) {
                    var recovered = null;
                    try { recovered = cachedLayer.projectItem; } catch (eRecovered) { recovered = null; }
                    if (recovered) {
                        cache.adjustmentItem = recovered;
                        cache.adjustmentNodeId = String(recovered.nodeId);
                        return { ok: true, item: labelAdjustmentItem(recovered), importedSequenceItem: null };
                    }
                }
            }
            cache.adjustmentNodeId = "";
            cache.donorSequenceId = "";
            cache.adjustmentItem = null;
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
            // Last resort for builds that do not expose a clip's project item
            // directly: search the donor sequence item's containing bin first.
            if (itemNodeId) {
                item = findProjectItemInSequences(project, itemNodeId);
                if (!item) item = findProjectItemByNodeId(project.rootItem, itemNodeId);
            }
        }
        if (!item) {
            return { ok: false, code: "NO_ADJUSTMENT_ITEM", message: "The layer source is unavailable. Reinstall the extension." };
        }

        var sequenceItem = null;
        try { sequenceItem = donorSequence.projectItem; } catch (eSeqItem) { sequenceItem = null; }

        cache.projectPath = projectPath;
        cache.rateTicks = String(rateTicks);
        cache.adjustmentNodeId = String(item.nodeId);
        cache.adjustmentItem = item;
        cache.donorSequenceId = "";
        try { cache.donorSequenceId = String(donorSequence.sequenceID); } catch (eDonorId) { cache.donorSequenceId = ""; }

        return {
            ok: true,
            item: labelAdjustmentItem(item),
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

    // `guess` is the index of the inserted layer from the timeline index. When
    // it is correct this reads a single clip instead of scanning the track; the
    // linear scan remains as a correctness fallback.
    function findInsertedLayer(track, startTicks, endTicks, guess) {
        var position = locateLayerAt(track, startTicks, endTicks, guess);
        if (position >= 0) {
            var found = getClipAt(track, position);
            var foundIsLayer = false;
            try { foundIsLayer = found.isAdjustmentLayer() === true; } catch (eFound) { foundIsLayer = false; }
            if (foundIsLayer) return found;
        }
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

    function rollbackLayer(track, startTicks, endTicks, timeline, trackIndex) {
        // With the timeline index the layer is at the slot before the first
        // later start; touching it directly avoids a full track scan on every
        // failure path.
        var entry = (timeline && typeof trackIndex === "number") ? indexTrack(timeline, trackIndex) : null;
        if (entry) {
            var guess = 0;
            while (guess < entry.ranges.length && entry.ranges[guess].start < startTicks) guess++;
            var candidate = getClipAt(track, guess);
            if (candidate && clipRangeMatches(candidate, startTicks, endTicks)) {
                var candidateIsLayer = false;
                try { candidateIsLayer = candidate.isAdjustmentLayer() === true; } catch (eCandidate) { candidateIsLayer = false; }
                if (candidateIsLayer) {
                    try {
                        candidate.remove(0, 0);
                        dropTrackIndex(timeline, trackIndex);
                        return true;
                    } catch (eRemoveTargeted) {
                        dropTrackIndex(timeline, trackIndex);
                        return false;
                    }
                }
            }
            dropTrackIndex(timeline, trackIndex);
        }

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
                    dropTrackIndex(timeline, trackIndex);
                    return true;
                } catch (eRemove) {
                    return false;
                }
            }
        }
        return false;
    }

    // QE track items interleave empty gaps, so the inserted clip has to be
    // found by type and exact tick range rather than by a fixed index. The
    // caller passes the active sequence once per run instead of re-fetching it
    // for every lookup.
    function findQeClipItem(trackIndex, startTicks, endTicks, qeSequence) {
        if (typeof qe === "undefined" || !qe) return null;
        if (!qeSequence) {
            try { qeSequence = qe.project.getActiveSequence(); } catch (eSeq) { qeSequence = null; }
        }
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
        var filePath = "";
        try { filePath = String(file.fsName); } catch (ePath) { filePath = String(file); }

        // The preset only changes when the file is edited; parsing its XML on
        // every click was wasted work.
        var cache = state();
        var cacheKey = filePath + "|" + modified;
        if (cache.presetKey === cacheKey && cache.preset) return cache.preset;

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

        var preset = { matchName: matchName, displayName: displayName, params: params, modified: modified };
        cache.presetKey = cacheKey;
        cache.preset = preset;
        return preset;
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
    function findAddedComponent(track, startTicks, endTicks, position) {
        var clip = findInsertedLayer(track, startTicks, endTicks, position);
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
    function applyLayerPreset(preset, trackIndex, track, startTicks, endTicks, replaceLayer, layerPosition) {
        try { app.enableQE(); } catch (eEnable) { return { ok: false }; }

        var qeSequence = null;
        try { qeSequence = qe.project.getActiveSequence(); } catch (eQeSequence) { qeSequence = null; }

        // Remember which lookup produced a working effect so later clicks go
        // straight to it instead of probing every name again.
        var cache = state();
        var cacheKey = preset.matchName + "|" + preset.params.length + "|" + preset.modified;
        var cachedLookup = cache.effectCacheKey === cacheKey ? cache.effectLookup : "";

        var candidates = [];
        if (cachedLookup) {
            var cachedEffect = null;
            try { cachedEffect = qe.project.getVideoEffectByName(cachedLookup); } catch (eCachedEffect) { cachedEffect = null; }
            if (cachedEffect) candidates.push({ effect: cachedEffect, lookup: cachedLookup, preferred: true });
        }

        function tryCandidates(list) {
            var qeItem = findQeClipItem(trackIndex, startTicks, endTicks, qeSequence);
            for (var c = 0; c < list.length; c++) {
                if (!qeItem) {
                    qeItem = findQeClipItem(trackIndex, startTicks, endTicks, qeSequence);
                    if (!qeItem) return { ok: false };
                }
                try {
                    qeItem.addVideoEffect(list[c].effect);
                } catch (eAdd) {
                    continue;
                }

                var added = findAddedComponent(track, startTicks, endTicks, layerPosition);
                if (!added) {
                    layerPosition = replaceLayer();
                    if (layerPosition < 0) return { ok: false };
                    qeItem = null;
                    continue;
                }

                var exact = added.matchName === preset.matchName;
                var sameEffect = /Geometry/.test(added.matchName) && /Geometry/.test(preset.matchName);
                var sameControls = sameEffect && propertyCount(added.component) === preset.params.length;
                if (!exact && !sameControls) {
                    layerPosition = replaceLayer();
                    if (layerPosition < 0) return { ok: false };
                    qeItem = null;
                    continue;
                }

                if (!writePresetValues(added.component, preset)) {
                    layerPosition = replaceLayer();
                    if (layerPosition < 0) return { ok: false };
                    qeItem = null;
                    continue;
                }
                cache.effectCacheKey = cacheKey;
                cache.effectLookup = list[c].lookup;
                return { ok: true, exact: exact };
            }
            return { ok: false };
        }

        // The cached lookup is just an optimisation; if it stops working (new
        // project, different effect set) fall back to a full lookup once.
        if (candidates.length > 0) {
            var cachedResult = tryCandidates(candidates);
            if (cachedResult.ok) return cachedResult;
        }
        return tryCandidates(presetEffectCandidates(preset));
    }

    // A clip collides only when its range actually intersects the target range.
    // Ranges are half-open, so a clip ending exactly at startTicks (or starting
    // exactly at endTicks) does not block the insertion.
    function isTrackFree(track, startTicks, endTicks, timeline, trackIndex) {
        var locked = false;
        try { locked = track.isLocked() === true; } catch (eLocked) { locked = false; }
        if (locked) return false;

        var entry = (timeline && typeof trackIndex === "number") ? indexTrack(timeline, trackIndex) : null;
        if (entry) {
            var ranges = entry.ranges;
            for (var r = 0; r < ranges.length; r++) {
                if (ranges[r].start < endTicks && ranges[r].end > startTicks) return false;
            }
            return true;
        }

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
        var timeline = null;

        function restoreInserted() {
            var restored = true;
            for (var k = insertedLayers.length - 1; k >= 0; k--) {
                var record = insertedLayers[k];
                if (!rollbackLayer(record.track, record.startTicks, record.endTicks, timeline, record.trackIndex)) restored = false;
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
            if (!activeSequenceReadable(sequence)) {
                return response(false, "NO_ACTIVE_SEQUENCE", "Open a sequence first.");
            }

            timeline = buildTimelineIndex(sequence);

            var selection = selectionItems(sequence);
            if (selection.length === 0) {
                return response(false, "NO_SELECTION", "Please select a video clip first.");
            }

            var videoSelection = videoItemsOf(selection);
            if (videoSelection.length === 0) {
                return response(false, "NOT_VIDEO_CLIP", "Select a video clip, not an audio or other item.");
            }

            var map = selectedVideoMap(sequence, videoSelection);
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
                    if (isTrackFree(candidate, job.startTicks, job.endTicks, timeline, targetIndex)) {
                        targetTrack = candidate;
                        break;
                    }
                }

                var placedPosition = -1;
                var placeLayer = (function (track, trackIndex, startTicks, endTicks) {
                    return function () {
                        placedPosition = -1;
                        var entry = indexTrack(timeline, trackIndex);
                        var countBefore = -1;
                        try { countBefore = track.clips.numItems; } catch (eBefore) { countBefore = -1; }
                        var insertTime = new Time();
                        insertTime.ticks = String(startTicks);
                        try {
                            track.overwriteClip(item, insertTime);
                        } catch (eInsert) {
                            dropTrackIndex(timeline, trackIndex);
                            return false;
                        }
                        var countAfter = -1;
                        try { countAfter = track.clips.numItems; } catch (eAfter) { countAfter = -1; }

                        // The range was checked empty, so a correct insert adds
                        // exactly one clip. Anything else means the timeline
                        // changed underneath us: remove only the layer we put
                        // here and fail instead of touching other clips.
                        if (countBefore < 0 || countAfter !== countBefore + 1) {
                            rollbackLayer(track, startTicks, endTicks, timeline, trackIndex);
                            return false;
                        }

                        var guess = -1;
                        if (entry) {
                            guess = 0;
                            while (guess < entry.ranges.length && entry.ranges[guess].start < startTicks) guess++;
                        }
                        var position = locateLayerAt(track, startTicks, endTicks, guess);
                        var layer = getClipAt(track, position);
                        var isLayer = false;
                        if (layer) {
                            try { isLayer = layer.isAdjustmentLayer() === true; } catch (eLayer) { isLayer = false; }
                        }
                        if (!isLayer) {
                            rollbackLayer(track, startTicks, endTicks, timeline, trackIndex);
                            return false;
                        }
                        placedPosition = position;
                        if (entry) indexInsert(timeline, trackIndex, startTicks, endTicks);
                        return true;
                    };
                })(targetTrack, targetIndex, job.startTicks, job.endTicks);

                var replaceLayer = (function (track, startTicks, endTicks) {
                    return function () {
                        if (!rollbackLayer(track, startTicks, endTicks, timeline, targetIndex)) return -1;
                        if (!placeLayer()) return -1;
                        return placedPosition;
                    };
                })(targetTrack, job.startTicks, job.endTicks);

                if (!placeLayer()) {
                    // A stale cached item is the likely cause; rebuild it on
                    // the next click instead of failing the same way again.
                    invalidateAdjustmentCache();
                    return fail("PLACEMENT_FAILED", "An adjustment layer could not be placed.");
                }

                var presetResult = applyLayerPreset(preset, targetIndex, targetTrack, job.startTicks, job.endTicks, replaceLayer, placedPosition);
                if (!presetResult.ok) {
                    rollbackLayer(targetTrack, job.startTicks, job.endTicks, timeline, targetIndex);
                    return fail("PRESET_FAILED", "Could not apply the Transform(openClick) preset.");
                }
                if (!presetResult.exact) usedLegacyTransform = true;

                insertedLayers.push({
                    track: targetTrack,
                    trackIndex: targetIndex,
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

    // ---------------------------------------------------------------------
    // Nested Clips
    //
    // Premiere has no direct "nest selection" call. createSubsequence() builds
    // a sequence from the current in/out range, respecting track targeting and
    // the clip selection; the scripting guide's nest example then overwrites
    // the range with that sequence's project item. This tool follows the same
    // path, but every subsequence is inspected first: only when it contains
    // exactly the selected clips (and their linked audio) does the timeline get
    // touched.
    // ---------------------------------------------------------------------

    var NEST_TOLERANCE_TICKS = 1;

    function failNest(code, message) {
        throw { openClickCode: code, message: message };
    }

    function clipNodeId(item) {
        var id = "";
        try { id = String(item.nodeId); } catch (e) { id = ""; }
        return id;
    }

    function clipProjectItemId(item) {
        var id = "";
        try {
            var projectItem = item.projectItem;
            if (projectItem) id = String(projectItem.nodeId);
        } catch (e) { id = ""; }
        return id;
    }

    // Reading in/out points is two extra host calls per clip, and only nest
    // expansion needs them. Everything else scans without marks so long
    // timelines stay quick.
    function allClipEntries(sequence, needMarks) {
        var entries = [];
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
                    var inTicks = NaN;
                    var outTicks = NaN;
                    if (needMarks) {
                        try { inTicks = ticksOf(clip.inPoint); } catch (eIn) { inTicks = NaN; }
                        try { outTicks = ticksOf(clip.outPoint); } catch (eOut) { outTicks = NaN; }
                    }
                    entries.push({
                        type: groups[g].type,
                        trackIndex: t,
                        track: track,
                        clip: clip,
                        nodeId: clipNodeId(clip),
                        projectItemNodeId: clipProjectItemId(clip),
                        startTicks: ticksOf(clip.start),
                        endTicks: ticksOf(clip.end),
                        inTicks: inTicks,
                        outTicks: outTicks
                    });
                }
            }
        }
        return entries;
    }

    function selectedNodeIdMap(sequence) {
        var map = {};
        var items = selectionItems(sequence);
        for (var i = 0; i < items.length; i++) {
            var id = clipNodeId(items[i]);
            if (id) map[id] = true;
        }
        return map;
    }

    // byNodeId, when supplied, is the map built once from the timeline scan the
    // caller already performed, so selecting a plan does not rescan every clip.
    function applySelection(sequence, wanted, byNodeId) {
        if (byNodeId) {
            var current = selectionItems(sequence);
            var i;
            for (i = 0; i < current.length; i++) {
                var currentId = clipNodeId(current[i]);
                if (currentId && wanted[currentId]) continue;
                // Every change is flushed: Premiere can keep the previous
                // plan's clips selected if only the final item updates the UI,
                // and then createSubsequence() would include the wrong clips.
                try { current[i].setSelected(false, true); } catch (eDeselect) {}
            }
            for (var id in wanted) {
                if (!wanted[id]) continue;
                var entry = byNodeId[id];
                if (!entry) continue;
                var selected = false;
                try { selected = !!entry.clip.isSelected(); } catch (eSelected) { selected = false; }
                if (!selected) {
                    try { entry.clip.setSelected(true, true); } catch (eSelect) {}
                }
            }
            return;
        }

        var entries = allClipEntries(sequence);
        for (var e = 0; e < entries.length; e++) {
            var entry = entries[e];
            var want = !!(entry.nodeId && wanted[entry.nodeId]);
            var isSelected = false;
            try { isSelected = !!entry.clip.isSelected(); } catch (eSel) { isSelected = false; }
            if (isSelected === want) continue;
            try { entry.clip.setSelected(want, true); } catch (eSet) {}
        }
    }

    function selectionMatches(sequence, wanted) {
        var actual = selectedNodeIdMap(sequence);
        for (var id in wanted) {
            if (wanted[id] && !actual[id]) return false;
        }
        for (var other in actual) {
            if (!wanted[other]) return false;
        }
        return true;
    }

    function ensureSelection(sequence, wanted, byNodeId) {
        applySelection(sequence, wanted, byNodeId);
        if (!selectionMatches(sequence, wanted)) {
            applySelection(sequence, wanted, byNodeId);
        }
    }

    // createSubsequence() can leave the new nest active, so this only opens the
    // sequence when it is not already in front. Reopening on every click made
    // the panel lag in large projects.
    function activateSequence(project, sequence) {
        if (!project || !sequence) return;
        var activeId = "";
        try { activeId = String(project.activeSequence.sequenceID); } catch (eActive) { activeId = ""; }
        var wantedId = "";
        try { wantedId = String(sequence.sequenceID); } catch (eWanted) { wantedId = ""; }
        if (activeId && wantedId && activeId === wantedId) return;
        try { project.openSequence(sequence.sequenceID); } catch (eOpen) {}
    }

    function readSequenceMarks(sequence) {
        var marks = { inPoint: null, outPoint: null };
        try { marks.inPoint = String(sequence.getInPoint()); } catch (eIn) { marks.inPoint = null; }
        try { marks.outPoint = String(sequence.getOutPoint()); } catch (eOut) { marks.outPoint = null; }
        return marks;
    }

    function restoreSequenceMarks(sequence, marks) {
        if (!marks) return;
        if (marks.inPoint !== null) {
            try { sequence.setInPoint(parseFloat(marks.inPoint)); } catch (eIn) {}
        }
        if (marks.outPoint !== null) {
            try { sequence.setOutPoint(parseFloat(marks.outPoint)); } catch (eOut) {}
        }
    }

    function readTargeting(sequence) {
        var saved = { video: [], audio: [], supported: true };
        var t;
        var videoCount = 0;
        try { videoCount = sequence.videoTracks.numTracks; } catch (eVideo) { videoCount = 0; }
        for (t = 0; t < videoCount; t++) {
            try { saved.video.push(!!sequence.videoTracks[t].isTargeted()); }
            catch (eV) { saved.video.push(null); saved.supported = false; }
        }
        var audioCount = 0;
        try { audioCount = sequence.audioTracks.numTracks; } catch (eAudio) { audioCount = 0; }
        for (t = 0; t < audioCount; t++) {
            try { saved.audio.push(!!sequence.audioTracks[t].isTargeted()); }
            catch (eA) { saved.audio.push(null); saved.supported = false; }
        }
        return saved;
    }

    function applyTargeting(sequence, videoWanted, audioWanted) {
        var ok = true;
        var t;
        for (t = 0; t < videoWanted.length; t++) {
            var wantVideo = !!videoWanted[t];
            try {
                if (!!sequence.videoTracks[t].isTargeted() === wantVideo) continue;
                sequence.videoTracks[t].setTargeted(wantVideo, true);
            } catch (eV) { ok = false; }
        }
        for (t = 0; t < audioWanted.length; t++) {
            var wantAudio = !!audioWanted[t];
            try {
                if (!!sequence.audioTracks[t].isTargeted() === wantAudio) continue;
                sequence.audioTracks[t].setTargeted(wantAudio, true);
            } catch (eA) { ok = false; }
        }
        return ok;
    }

    function targetingFlags(set, count) {
        var flags = [];
        for (var i = 0; i < count; i++) flags.push(!!set[i]);
        return flags;
    }

    function trackCounts(sequence) {
        var counts = { video: 0, audio: 0 };
        try { counts.video = sequence.videoTracks.numTracks; } catch (eVideo) { counts.video = 0; }
        try { counts.audio = sequence.audioTracks.numTracks; } catch (eAudio) { counts.audio = 0; }
        return counts;
    }

    // The subsequence copies the tracks that are targeted, so only the tracks
    // used by this plan may be targeted while it is created.
    function applyCreationTargeting(sequence, plan) {
        var counts = trackCounts(sequence);
        return applyTargeting(sequence,
            targetingFlags(plan.videoTrackSet, counts.video),
            targetingFlags(plan.audioTrackSet, counts.audio));
    }

    // Placement only needs the destination tracks targeted, so stray linked
    // media lands where the plan can verify and clean it up.
    function applyInsertionTargeting(sequence, plan) {
        var counts = trackCounts(sequence);
        var videoFlags = [];
        var audioFlags = [];
        var i;
        for (i = 0; i < counts.video; i++) videoFlags.push(i === plan.destVideoTrackIndex);
        for (i = 0; i < counts.audio; i++) {
            audioFlags.push(plan.destAudioTrackIndex >= 0 && i === plan.destAudioTrackIndex);
        }
        return applyTargeting(sequence, videoFlags, audioFlags);
    }

    function restoreTargeting(sequence, saved) {
        if (!saved || !saved.supported) return;
        applyTargeting(sequence, saved.video, saved.audio);
    }

    function trackIsLocked(track) {
        var locked = false;
        try { locked = track.isLocked() === true; } catch (e) { locked = false; }
        return locked;
    }

    function nestTrackLabel(type, index) {
        return (type === "video" ? "V" : "A") + (index + 1);
    }

    function rangesOverlap(startA, endA, startB, endB) {
        return startA < endB && endA > startB;
    }

    function sameNestRange(entry, plan) {
        return Math.abs(Number(entry.startTicks) - plan.startTicks) <= NEST_TOLERANCE_TICKS &&
            Math.abs(Number(entry.endTicks) - plan.endTicks) <= NEST_TOLERANCE_TICKS;
    }

    function pushExpectedClip(list, type, projectItemNodeId, clipStartTicks, clipEndTicks, planStartTicks, planEndTicks) {
        var start = Math.max(clipStartTicks, planStartTicks);
        var end = Math.min(clipEndTicks, planEndTicks);
        if (!(end > start)) return;
        list.push({
            type: type,
            projectItemNodeId: projectItemNodeId,
            startTicks: start - planStartTicks,
            endTicks: end - planStartTicks
        });
    }

    function addTrackIndex(list, set, index) {
        if (!set[index]) {
            set[index] = true;
            list.push(index);
        }
    }

    function buildNestPlans(sequence, combined) {
        var entries = allClipEntries(sequence);
        var byNodeId = {};
        var audioEntries = [];
        var i;
        for (i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.nodeId) byNodeId[entry.nodeId] = entry;
            if (entry.type === "audio") audioEntries.push(entry);
        }

        var selected = selectionItems(sequence);
        var selectedVideo = videoItemsOf(selected);
        if (selectedVideo.length === 0) {
            failNest("NO_SELECTION", "Please select a video clip first.");
        }

        var jobs = [];
        var seenJobs = {};
        for (i = 0; i < selectedVideo.length; i++) {
            var nodeId = clipNodeId(selectedVideo[i]);
            if (!nodeId || seenJobs[nodeId]) continue;
            seenJobs[nodeId] = true;
            var videoEntry = byNodeId[nodeId];
            if (!videoEntry || videoEntry.type !== "video") {
                failNest("NOT_VIDEO_CLIP", "Select video clips from the timeline and try again.");
            }
            if (!isFinite(videoEntry.startTicks) || !isFinite(videoEntry.endTicks) ||
                videoEntry.endTicks <= videoEntry.startTicks) {
                failNest("UNREADABLE_TIMING", "Could not read a selected clip's timing.");
            }
            jobs.push({
                entry: videoEntry,
                nodeId: videoEntry.nodeId,
                trackIndex: videoEntry.trackIndex,
                startTicks: videoEntry.startTicks,
                endTicks: videoEntry.endTicks,
                projectItemNodeId: videoEntry.projectItemNodeId,
                audioEntries: []
            });
        }
        if (jobs.length === 0) {
            failNest("NOT_VIDEO_CLIP", "Select a video clip, not an audio or other item.");
        }

        // A camera clip and its linked audio share the source project item.
        // Match on that plus a timeline overlap so a second use of the same
        // source elsewhere is not pulled into this nest.
        var j;
        for (i = 0; i < audioEntries.length; i++) {
            var audioEntry = audioEntries[i];
            if (!audioEntry.projectItemNodeId) continue;
            for (j = 0; j < jobs.length; j++) {
                var job = jobs[j];
                if (!job.projectItemNodeId || job.projectItemNodeId !== audioEntry.projectItemNodeId) continue;
                if (!rangesOverlap(job.startTicks, job.endTicks, audioEntry.startTicks, audioEntry.endTicks)) continue;
                job.audioEntries.push(audioEntry);
                break;
            }
        }

        for (j = 0; j < jobs.length; j++) {
            var audioTracks = {};
            var audioTrackCount = 0;
            for (i = 0; i < jobs[j].audioEntries.length; i++) {
                addTrackIndex([], audioTracks, jobs[j].audioEntries[i].trackIndex);
            }
            for (var trackKey in audioTracks) {
                if (audioTracks.hasOwnProperty && audioTracks.hasOwnProperty(trackKey)) audioTrackCount++;
            }
            if (audioTrackCount > 1) {
                failNest("MULTI_AUDIO_UNSUPPORTED", "A selected clip has linked audio on more than one track. Nest the clips separately.");
            }
        }

        var plans = [];
        if (combined && jobs.length > 1) {
            var rangeStart = jobs[0].startTicks;
            var rangeEnd = jobs[0].endTicks;
            var destVideoTrack = jobs[0].trackIndex;
            var destAudioTrack = -1;
            var videoIndices = [];
            var videoSet = {};
            var audioIndices = [];
            var audioSet = {};
            var selection = {};
            var audioJobs = [];
            var seenAudio = {};
            var k;

            for (j = 0; j < jobs.length; j++) {
                var combinedJob = jobs[j];
                if (combinedJob.startTicks < rangeStart) rangeStart = combinedJob.startTicks;
                if (combinedJob.endTicks > rangeEnd) rangeEnd = combinedJob.endTicks;
                if (combinedJob.trackIndex > destVideoTrack) destVideoTrack = combinedJob.trackIndex;
                addTrackIndex(videoIndices, videoSet, combinedJob.trackIndex);
                selection[combinedJob.nodeId] = true;
                for (k = 0; k < combinedJob.audioEntries.length; k++) {
                    var combinedAudio = combinedJob.audioEntries[k];
                    if (combinedAudio.startTicks < rangeStart) rangeStart = combinedAudio.startTicks;
                    if (combinedAudio.endTicks > rangeEnd) rangeEnd = combinedAudio.endTicks;
                    if (destAudioTrack < 0) destAudioTrack = combinedAudio.trackIndex;
                    addTrackIndex(audioIndices, audioSet, combinedAudio.trackIndex);
                    selection[combinedAudio.nodeId] = true;
                    if (!seenAudio[combinedAudio.nodeId]) {
                        seenAudio[combinedAudio.nodeId] = true;
                        audioJobs.push(combinedAudio);
                    }
                }
            }

            if (audioIndices.length > 1) {
                failNest("MULTI_AUDIO_UNSUPPORTED", "The selected clips have linked audio on more than one track. Nest them separately.");
            }

            var combinedExpected = [];
            for (j = 0; j < jobs.length; j++) {
                pushExpectedClip(combinedExpected, "video", jobs[j].projectItemNodeId,
                    jobs[j].startTicks, jobs[j].endTicks, rangeStart, rangeEnd);
            }
            for (j = 0; j < audioJobs.length; j++) {
                pushExpectedClip(combinedExpected, "audio", audioJobs[j].projectItemNodeId,
                    audioJobs[j].startTicks, audioJobs[j].endTicks, rangeStart, rangeEnd);
            }

            plans.push({
                type: "combined",
                startTicks: rangeStart,
                endTicks: rangeEnd,
                videoJobs: jobs,
                audioJobs: audioJobs,
                destVideoTrackIndex: destVideoTrack,
                destAudioTrackIndex: destAudioTrack,
                videoTrackIndices: videoIndices,
                videoTrackSet: videoSet,
                audioTrackIndices: audioIndices,
                audioTrackSet: audioSet,
                selection: selection,
                expected: combinedExpected
            });
        } else {
            for (j = 0; j < jobs.length; j++) {
                var singleJob = jobs[j];
                var startTicks = singleJob.startTicks;
                var endTicks = singleJob.endTicks;
                var singleAudioIndices = [];
                var singleAudioSet = {};
                var singleSelection = {};
                var singleAudioJobs = [];
                var singleExpected = [];
                var singleDestAudio = -1;
                var m;

                singleSelection[singleJob.nodeId] = true;
                for (m = 0; m < singleJob.audioEntries.length; m++) {
                    var singleAudio = singleJob.audioEntries[m];
                    if (singleAudio.startTicks < startTicks) startTicks = singleAudio.startTicks;
                    if (singleAudio.endTicks > endTicks) endTicks = singleAudio.endTicks;
                    if (singleDestAudio < 0) singleDestAudio = singleAudio.trackIndex;
                    addTrackIndex(singleAudioIndices, singleAudioSet, singleAudio.trackIndex);
                    singleSelection[singleAudio.nodeId] = true;
                    singleAudioJobs.push(singleAudio);
                }

                pushExpectedClip(singleExpected, "video", singleJob.projectItemNodeId,
                    singleJob.startTicks, singleJob.endTicks, startTicks, endTicks);
                for (m = 0; m < singleAudioJobs.length; m++) {
                    pushExpectedClip(singleExpected, "audio", singleAudioJobs[m].projectItemNodeId,
                        singleAudioJobs[m].startTicks, singleAudioJobs[m].endTicks, startTicks, endTicks);
                }

                var singleVideoIndices = [];
                var singleVideoSet = {};
                addTrackIndex(singleVideoIndices, singleVideoSet, singleJob.trackIndex);

                plans.push({
                    type: "single",
                    startTicks: startTicks,
                    endTicks: endTicks,
                    videoJobs: [singleJob],
                    audioJobs: singleAudioJobs,
                    destVideoTrackIndex: singleJob.trackIndex,
                    destAudioTrackIndex: singleDestAudio,
                    videoTrackIndices: singleVideoIndices,
                    videoTrackSet: singleVideoSet,
                    audioTrackIndices: singleAudioIndices,
                    audioTrackSet: singleAudioSet,
                    selection: singleSelection,
                    expected: singleExpected
                });
            }
        }

        return { plans: plans, entries: entries, byNodeId: byNodeId };
    }

    function validateNestPlan(sequence, plan, entries) {
        var allowed = {};
        var i;
        for (i = 0; i < plan.videoJobs.length; i++) allowed[plan.videoJobs[i].nodeId] = true;
        for (i = 0; i < plan.audioJobs.length; i++) allowed[plan.audioJobs[i].nodeId] = true;

        for (i = 0; i < plan.videoTrackIndices.length; i++) {
            var videoIndex = plan.videoTrackIndices[i];
            var videoTrack = null;
            try { videoTrack = sequence.videoTracks[videoIndex]; } catch (eV) { videoTrack = null; }
            if (!videoTrack) failNest("TRACK_MISSING", "A selected video track is unavailable.");
            if (trackIsLocked(videoTrack)) {
                failNest("TRACK_LOCKED", "Unlock " + nestTrackLabel("video", videoIndex) + " before nesting.");
            }
            var videoCount = 0;
            try { videoCount = videoTrack.clips.numItems; } catch (eVC) { videoCount = 0; }
            for (var v = 0; v < videoCount; v++) {
                var videoClip = videoTrack.clips[v];
                var vStart = ticksOf(videoClip.start);
                var vEnd = ticksOf(videoClip.end);
                if (!rangesOverlap(vStart, vEnd, plan.startTicks, plan.endTicks)) continue;
                if (!allowed[clipNodeId(videoClip)]) {
                    failNest("RANGE_CONFLICT", "Another clip is inside the selected range on " +
                        nestTrackLabel("video", videoIndex) + ". Move it or include it in the selection.");
                }
            }
        }

        for (i = 0; i < plan.audioTrackIndices.length; i++) {
            var audioIndex = plan.audioTrackIndices[i];
            var audioTrack = null;
            try { audioTrack = sequence.audioTracks[audioIndex]; } catch (eA) { audioTrack = null; }
            if (!audioTrack) failNest("TRACK_MISSING", "A selected audio track is unavailable.");
            if (trackIsLocked(audioTrack)) {
                failNest("TRACK_LOCKED", "Unlock " + nestTrackLabel("audio", audioIndex) + " before nesting.");
            }
            var audioCount = 0;
            try { audioCount = audioTrack.clips.numItems; } catch (eAC) { audioCount = 0; }
            for (var a = 0; a < audioCount; a++) {
                var audioClip = audioTrack.clips[a];
                var aStart = ticksOf(audioClip.start);
                var aEnd = ticksOf(audioClip.end);
                if (!rangesOverlap(aStart, aEnd, plan.startTicks, plan.endTicks)) continue;
                if (!allowed[clipNodeId(audioClip)]) {
                    failNest("RANGE_CONFLICT", "Another audio clip is inside the selected range on " +
                        nestTrackLabel("audio", audioIndex) + ". Move it or include it in the selection.");
                }
            }
        }
    }

    function nestItemDurationTicks(item) {
        var inTicks = NaN;
        var outTicks = NaN;
        try { inTicks = ticksOf(item.getInPoint()); } catch (eIn) { inTicks = NaN; }
        try { outTicks = ticksOf(item.getOutPoint()); } catch (eOut) { outTicks = NaN; }
        if (!isFinite(inTicks) || !isFinite(outTicks)) return NaN;
        if (inTicks < 0 || outTicks < 0) return NaN;
        if (outTicks <= inTicks) return NaN;
        return outTicks - inTicks;
    }

    function verifyNestedContent(nested, plan) {
        var actual = allClipEntries(nested);
        var used = [];
        var wantedDuration = plan.endTicks - plan.startTicks;
        var maxEnd = 0;
        var i;
        var j;

        for (i = 0; i < actual.length; i++) {
            if (isFinite(actual[i].endTicks) && actual[i].endTicks > maxEnd) maxEnd = actual[i].endTicks;
        }
        if (!isFinite(maxEnd) || Math.abs(maxEnd - wantedDuration) > NEST_TOLERANCE_TICKS) {
            return {
                ok: false,
                code: "NEST_DURATION_MISMATCH",
                message: "The nested sequence's timing did not match the selected clip."
            };
        }

        var itemDuration = nestItemDurationTicks(plan.nestedItem);
        if (isFinite(itemDuration) && Math.abs(itemDuration - wantedDuration) > NEST_TOLERANCE_TICKS) {
            return {
                ok: false,
                code: "NEST_DURATION_MISMATCH",
                message: "The nested sequence's duration did not match the selected clip."
            };
        }

        for (i = 0; i < plan.expected.length; i++) {
            var want = plan.expected[i];
            var found = false;
            for (j = 0; j < actual.length; j++) {
                if (used[j]) continue;
                var have = actual[j];
                if (have.type !== want.type) continue;
                if (have.projectItemNodeId !== want.projectItemNodeId) continue;
                if (Math.abs(have.startTicks - want.startTicks) > NEST_TOLERANCE_TICKS) continue;
                if (Math.abs(have.endTicks - want.endTicks) > NEST_TOLERANCE_TICKS) continue;
                used[j] = true;
                found = true;
                break;
            }
            if (!found) {
                return {
                    ok: false,
                    code: "NEST_CONTENT_MISMATCH",
                    message: "The nested sequence did not contain the selected clip exactly."
                };
            }
        }
        for (j = 0; j < actual.length; j++) {
            if (!used[j]) {
                return {
                    ok: false,
                    code: "NEST_CONTENT_MISMATCH",
                    message: "The selected range also contained other timeline content."
                };
            }
        }
        return { ok: true, code: "OK", message: "" };
    }

    function nestSequenceName(sequence, plan, index, planCount) {
        var name = "";
        if (plan.type === "combined") {
            try { name = String(sequence.name); } catch (eSeq) { name = ""; }
            name = name ? name + " Nest" : "Nested Clips";
        } else {
            try { name = String(plan.videoJobs[0].entry.clip.name); } catch (eClip) { name = ""; }
            if (name) {
                name = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
                name = name + " Nest";
            } else {
                name = "Nested Clip";
            }
        }
        if (planCount > 1) name = name + " " + (index + 1);
        return name;
    }

    function createNestPlanSubsequence(ctx, plan, index, planCount) {
        var sequence = ctx.sequence;
        activateSequence(ctx.project, sequence);
        ensureSelection(sequence, plan.selection, ctx.byNodeId);
        if (ctx.savedTargeting && ctx.savedTargeting.supported) {
            applyCreationTargeting(sequence, plan);
        }
        sequence.setInPoint(plan.startTicks / TICKS_PER_SECOND);
        sequence.setOutPoint(plan.endTicks / TICKS_PER_SECOND);

        var nested = null;
        try { nested = sequence.createSubsequence(false); } catch (eCreate) { nested = null; }
        if (!nested) {
            failNest("SUBSEQUENCE_FAILED", "Could not create a nested sequence for a selected clip.");
        }

        plan.nested = nested;
        plan.nestedItem = null;
        try { plan.nestedItem = nested.projectItem; } catch (eItem) { plan.nestedItem = null; }
        if (!plan.nestedItem) {
            failNest("SUBSEQUENCE_FAILED", "Could not prepare the nested sequence.");
        }
        plan.nestedItemNodeId = clipNodeId(plan.nestedItem);
        if (!plan.nestedItemNodeId) {
            failNest("SUBSEQUENCE_FAILED", "Could not read the nested sequence's identity.");
        }
        ctx.created.push(plan);

        try { nested.name = nestSequenceName(sequence, plan, index, planCount); } catch (eName) {}

        var check = verifyNestedContent(nested, plan);
        if (!check.ok) {
            failNest(check.code, check.message);
        }
    }

    function snapshotNestTimeline(sequence) {
        var entries = allClipEntries(sequence);
        var snapshot = [];
        for (var i = 0; i < entries.length; i++) {
            snapshot.push({
                key: entries[i].type + ":" + entries[i].nodeId,
                type: entries[i].type,
                trackIndex: entries[i].trackIndex,
                nodeId: entries[i].nodeId,
                projectItemNodeId: entries[i].projectItemNodeId,
                startTicks: String(entries[i].startTicks),
                endTicks: String(entries[i].endTicks)
            });
        }
        return snapshot;
    }

    // A nest insert only writes to the destination tracks and removes the
    // plan's own source clips, so those are the only tracks that need a
    // before/after inventory. This keeps the check cheap on long timelines.
    function nestSnapshotTracks(sequence, plan) {
        var videoIndices = [];
        var audioIndices = [];
        var i;
        for (i = 0; i < plan.videoTrackIndices.length; i++) videoIndices.push(plan.videoTrackIndices[i]);
        if (plan.destVideoTrackIndex >= 0) videoIndices.push(plan.destVideoTrackIndex);
        for (i = 0; i < plan.audioTrackIndices.length; i++) audioIndices.push(plan.audioTrackIndices[i]);
        if (plan.destAudioTrackIndex >= 0) audioIndices.push(plan.destAudioTrackIndex);
        return snapshotTracks(sequence, videoIndices, audioIndices);
    }

    function findNestClip(sequence, nodeId) {
        if (!nodeId) return null;
        var entries = allClipEntries(sequence);
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].nodeId === nodeId) return entries[i];
        }
        return null;
    }

    function findNestClipOnTrack(sequence, nodeId, type, trackIndex) {
        if (!nodeId) return null;
        var tracks = type === "video" ? sequence.videoTracks : sequence.audioTracks;
        var track = null;
        try { track = tracks[trackIndex]; } catch (eTrack) { track = null; }
        if (!track) return null;
        var entries = entriesOnTrack(track, type, trackIndex);
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].nodeId === nodeId) return entries[i];
        }
        return null;
    }

    function removeNestClip(sequence, nodeId) {
        var entry = findNestClip(sequence, nodeId);
        if (!entry) return true;
        try { entry.clip.remove(0, 0); } catch (e) { return false; }
        return !findNestClip(sequence, nodeId);
    }

    // Removals happen on known tracks; scanning just that track keeps multi-clip
    // nests linear instead of scanning the whole timeline per clip.
    function removeNestClipAt(sequence, nodeId, type, trackIndex) {
        var entry = findNestClipOnTrack(sequence, nodeId, type, trackIndex);
        if (!entry) return true;
        try { entry.clip.remove(0, 0); } catch (e) { return false; }
        return !findNestClipOnTrack(sequence, nodeId, type, trackIndex);
    }

    function entriesOnTrack(track, type, trackIndex) {
        var entries = [];
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { count = 0; }
        for (var c = 0; c < count; c++) {
            var clip = track.clips[c];
            entries.push({
                type: type,
                trackIndex: trackIndex,
                track: track,
                clip: clip,
                nodeId: clipNodeId(clip),
                projectItemNodeId: clipProjectItemId(clip),
                startTicks: ticksOf(clip.start),
                endTicks: ticksOf(clip.end)
            });
        }
        return entries;
    }

    // The nest insert only writes the destination video track; linked audio can
    // only appear on audio tracks. Scanning just those beats reading every
    // video clip in a long sequence.
    function nestedEntriesForPlan(sequence, plan) {
        var result = [];
        if (!plan.nestedItemNodeId) return result;

        var videoTrack = null;
        try { videoTrack = sequence.videoTracks[plan.destVideoTrackIndex]; } catch (eVideo) { videoTrack = null; }
        if (videoTrack) {
            var videos = entriesOnTrack(videoTrack, "video", plan.destVideoTrackIndex);
            for (var v = 0; v < videos.length; v++) {
                if (videos[v].projectItemNodeId === plan.nestedItemNodeId) result.push(videos[v]);
            }
        }

        var audioCount = trackCountOf(sequence.audioTracks);
        for (var a = 0; a < audioCount; a++) {
            var audios = entriesOnTrack(sequence.audioTracks[a], "audio", a);
            for (var i = 0; i < audios.length; i++) {
                if (audios[i].projectItemNodeId === plan.nestedItemNodeId) result.push(audios[i]);
            }
        }
        return result;
    }

    function pruneNestedClips(sequence, plan, wantsAudio) {
        var nested = nestedEntriesForPlan(sequence, plan);
        var keepVideo = null;
        var keepAudio = null;
        var fallbackVideo = null;
        var i;

        for (i = 0; i < nested.length; i++) {
            var entry = nested[i];
            if (entry.type === "video") {
                if (!fallbackVideo) fallbackVideo = entry;
                if (!keepVideo && entry.trackIndex === plan.destVideoTrackIndex && sameNestRange(entry, plan)) {
                    keepVideo = entry;
                }
            } else if (entry.type === "audio" && wantsAudio) {
                if (!keepAudio && entry.trackIndex === plan.destAudioTrackIndex && sameNestRange(entry, plan)) {
                    keepAudio = entry;
                }
            }
        }
        if (!keepVideo) keepVideo = fallbackVideo;

        for (i = 0; i < nested.length; i++) {
            var current = nested[i];
            if (keepVideo && current.nodeId === keepVideo.nodeId) continue;
            if (keepAudio && current.nodeId === keepAudio.nodeId) continue;
            try { current.clip.remove(0, 0); } catch (eRemove) {}
        }
        return { video: keepVideo, audio: keepAudio };
    }

    function nestedVideoAt(sequence, plan) {
        var entries = nestedEntriesForPlan(sequence, plan);
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.type === "video" && entry.trackIndex === plan.destVideoTrackIndex && sameNestRange(entry, plan)) {
                return entry;
            }
        }
        return null;
    }

    function insertNestPlan(ctx, plan) {
        var sequence = ctx.sequence;
        var insertTime = new Time();
        insertTime.ticks = String(plan.startTicks);

        var before = nestSnapshotTracks(sequence, plan);
        ctx.timelineTouched = true;
        if (ctx.savedTargeting && ctx.savedTargeting.supported) {
            applyInsertionTargeting(sequence, plan);
        }

        // Track.overwriteClip is the only placement call used here: it takes
        // the same Time object the adjustment-layer path already uses, while
        // Sequence.overwriteClip has been observed to ignore a seconds string
        // and overwrite from time zero.
        try {
            sequence.videoTracks[plan.destVideoTrackIndex].overwriteClip(plan.nestedItem, insertTime);
        } catch (eTrackOverwrite) {}
        var placed = nestedVideoAt(sequence, plan);
        if (!placed) {
            failNest("INSERT_FAILED", "A nested clip could not be placed on the timeline.");
        }

        // From here on the sequence is referenced by a timeline clip, so it
        // must never be deleted during cleanup.
        plan.keepSequence = true;

        if (plan.type === "combined") {
            var i;
            for (i = 0; i < plan.videoJobs.length; i++) {
                var videoJob = plan.videoJobs[i];
                if (videoJob.trackIndex === plan.destVideoTrackIndex) continue;
                if (!removeNestClipAt(sequence, videoJob.nodeId, "video", videoJob.trackIndex)) {
                    failNest("REMOVE_FAILED", "An original clip could not be removed from the timeline.");
                }
            }
            for (i = 0; i < plan.audioJobs.length; i++) {
                var audioJob = plan.audioJobs[i];
                if (audioJob.trackIndex === plan.destAudioTrackIndex) continue;
                if (!removeNestClipAt(sequence, audioJob.nodeId, "audio", audioJob.trackIndex)) {
                    failNest("REMOVE_FAILED", "An original audio clip could not be removed from the timeline.");
                }
            }
        }

        var wantsAudio = false;
        for (var e = 0; e < plan.expected.length; e++) {
            if (plan.expected[e].type === "audio") { wantsAudio = true; break; }
        }

        var pruned = pruneNestedClips(sequence, plan, wantsAudio);

        if (wantsAudio && !pruned.audio) {
            try {
                sequence.audioTracks[plan.destAudioTrackIndex].overwriteClip(plan.nestedItem, insertTime);
            } catch (eAudioFallback) {}
            pruned = pruneNestedClips(sequence, plan, wantsAudio);
        }

        if (!pruned.video) {
            failNest("NEST_CLIP_MISSING", "The nested clip was not placed at the selected range.");
        }
        if (wantsAudio && !pruned.audio) {
            failNest("NEST_AUDIO_MISSING", "The nested clip's audio could not be placed.");
        }

        plan.insertedVideoNodeId = pruned.video.nodeId;
        plan.insertedAudioNodeId = pruned.audio ? pruned.audio.nodeId : "";

        var after = nestSnapshotTracks(sequence, plan);
        var difference = diffTimeline(before, after);
        var verified = verifyNestDiff(difference, plan, wantsAudio);
        if (!verified.ok) {
            failNest(verified.code, verified.message);
        }

        plan.inserted = true;
        ctx.insertedCount++;
    }

    function verifyNestDiff(difference, plan, wantsAudio) {
        var expectedRemoved = [];
        var expectedMap = {};
        var i;

        for (i = 0; i < plan.videoJobs.length; i++) {
            expectedMap[plan.videoJobs[i].nodeId] = true;
            expectedRemoved.push(plan.videoJobs[i].nodeId);
        }
        for (i = 0; i < plan.audioJobs.length; i++) {
            if (!expectedMap[plan.audioJobs[i].nodeId]) {
                expectedMap[plan.audioJobs[i].nodeId] = true;
                expectedRemoved.push(plan.audioJobs[i].nodeId);
            }
        }

        for (i = 0; i < difference.removed.length; i++) {
            if (!expectedMap[difference.removed[i].nodeId]) {
                return {
                    ok: false,
                    code: "COLLATERAL_CHANGE",
                    message: "An unrelated clip was changed. Check the timeline."
                };
            }
        }
        var removedMap = {};
        for (i = 0; i < difference.removed.length; i++) removedMap[difference.removed[i].nodeId] = true;
        for (i = 0; i < expectedRemoved.length; i++) {
            if (!removedMap[expectedRemoved[i]]) {
                return {
                    ok: false,
                    code: "ORIGINAL_REMAINS",
                    message: "An original clip could not be replaced. Check the timeline."
                };
            }
        }

        if (difference.changed.length > 0) {
            return {
                ok: false,
                code: "COLLATERAL_CHANGE",
                message: "Another clip was trimmed or moved. Check the timeline."
            };
        }

        var addedVideo = null;
        var addedAudio = null;
        for (i = 0; i < difference.added.length; i++) {
            var added = difference.added[i];
            if (added.projectItemNodeId !== plan.nestedItemNodeId) {
                return {
                    ok: false,
                    code: "COLLATERAL_CHANGE",
                    message: "Another clip appeared on the timeline. Check it before continuing."
                };
            }
            if (added.type === "video") {
                if (addedVideo) {
                    return { ok: false, code: "DUPLICATE_NEST", message: "More than one nested clip was placed. Check the timeline." };
                }
                addedVideo = added;
            } else if (added.type === "audio") {
                if (addedAudio) {
                    return { ok: false, code: "DUPLICATE_NEST", message: "The nested audio was placed more than once. Check the timeline." };
                }
                addedAudio = added;
            }
        }

        if (!addedVideo) {
            return { ok: false, code: "NEST_CLIP_MISSING", message: "The nested clip was not found on the timeline." };
        }
        if (addedVideo.trackIndex !== plan.destVideoTrackIndex ||
            !sameNestRange({ startTicks: parseFloat(addedVideo.startTicks), endTicks: parseFloat(addedVideo.endTicks) }, plan)) {
            return {
                ok: false,
                code: "NEST_RANGE_MISMATCH",
                message: "The nested clip did not land at the selected range. Check the timeline."
            };
        }

        if (wantsAudio) {
            if (!addedAudio) {
                return { ok: false, code: "NEST_AUDIO_MISSING", message: "The nested clip's audio was not found on the timeline." };
            }
            if (addedAudio.trackIndex !== plan.destAudioTrackIndex ||
                !sameNestRange({ startTicks: parseFloat(addedAudio.startTicks), endTicks: parseFloat(addedAudio.endTicks) }, plan)) {
                return {
                    ok: false,
                    code: "NEST_AUDIO_RANGE_MISMATCH",
                    message: "The nested clip's audio did not land at the selected range. Check the timeline."
                };
            }
        } else if (addedAudio) {
            return {
                ok: false,
                code: "STRAY_NEST_AUDIO",
                message: "Unexpected audio was added inside the nest. Check the timeline."
            };
        }

        return { ok: true, code: "OK", message: "" };
    }

    function cleanupNest(ctx) {
        try {
            if (ctx.sequence) {
                activateSequence(ctx.project, ctx.sequence);
                try { restoreSequenceMarks(ctx.sequence, ctx.savedMarks); } catch (eMarks) {}
                try { restoreTargeting(ctx.sequence, ctx.savedTargeting); } catch (eTarget) {}
                try {
                    if (ctx.success && ctx.resultSelection) {
                        applySelection(ctx.sequence, ctx.resultSelection);
                    } else if (ctx.savedSelection) {
                        applySelection(ctx.sequence, ctx.savedSelection);
                    }
                } catch (eSelection) {}
            }
            for (var i = 0; i < ctx.created.length; i++) {
                var plan = ctx.created[i];
                if (plan.keepSequence) continue;
                try {
                    if (plan.nestedItem) deleteProjectItem(ctx.project, plan.nestedItem);
                } catch (eDelete) {}
            }
        } catch (eCleanup) {}
    }

    function nestFailureSuffix(ctx) {
        if (ctx.insertedCount === 1) {
            return " 1 clip was nested before the error. Check the timeline.";
        }
        if (ctx.insertedCount > 1) {
            return " " + ctx.insertedCount + " clips were nested before the error. Check the timeline.";
        }
        if (ctx.timelineTouched) {
            return " The timeline may have changed. Check it before continuing.";
        }
        return " Nothing was changed.";
    }

    function nestClips(combined, unnest) {
        if (unnest) {
            return unnestClips();
        }
        var ctx = {
            project: null,
            sequence: null,
            savedMarks: null,
            savedSelection: null,
            savedTargeting: null,
            created: [],
            insertedCount: 0,
            timelineTouched: false,
            success: false,
            resultSelection: null
        };

        try {
            var project = null;
            try { project = app.project; } catch (eProject) { project = null; }
            if (!project) {
                failNest("NO_PROJECT", "Open a project first.");
            }
            ctx.project = project;
            var version = 0;
            try { version = parseFloat(app.version); } catch (eVersion) { version = 0; }
            if (version && version < 22) {
                failNest("UNSUPPORTED_VERSION", "This version of Premiere Pro is not supported.");
            }

            var sequence = null;
            try { sequence = project.activeSequence; } catch (eSequence) { sequence = null; }
            if (!activeSequenceReadable(sequence)) {
                failNest("NO_ACTIVE_SEQUENCE", "Open a sequence first.");
            }
            ctx.sequence = sequence;

            var built = buildNestPlans(sequence, combined);
            ctx.byNodeId = built.byNodeId;
            var plans = built.plans;
            var i;
            for (i = 0; i < plans.length; i++) {
                validateNestPlan(sequence, plans[i], built.entries);
            }

            ctx.savedMarks = readSequenceMarks(sequence);
            ctx.savedSelection = selectedNodeIdMap(sequence);
            ctx.savedTargeting = readTargeting(sequence);

            for (i = 0; i < plans.length; i++) {
                createNestPlanSubsequence(ctx, plans[i], i, plans.length);
            }
            for (i = 0; i < plans.length; i++) {
                insertNestPlan(ctx, plans[i]);
            }

            var clipCount = 0;
            ctx.resultSelection = {};
            for (i = 0; i < plans.length; i++) {
                clipCount += plans[i].videoJobs.length;
                if (plans[i].insertedVideoNodeId) {
                    ctx.resultSelection[plans[i].insertedVideoNodeId] = true;
                }
            }

            ctx.success = true;
            if (plans.length === 1 && plans[0].type === "single") {
                return response(true, "OK", "Clip nested.");
            }
            if (plans.length === 1 && plans[0].type === "combined") {
                return response(true, "OK", "Nested " + clipCount + " clips into one clip.");
            }
            return response(true, "OK", "Nested " + clipCount + " clips.");
        } catch (e) {
            var code = e && e.openClickCode ? e.openClickCode : "UNEXPECTED_ERROR";
            var message = e && e.message ? e.message : "An unexpected error occurred.";
            return response(false, code, message + nestFailureSuffix(ctx));
        } finally {
            cleanupNest(ctx);
        }
    }

    // ---------------------------------------------------------------------
    // Unnest (Alt+click)
    //
    // Premiere has no unnest call. Every nested sequence clip on the active
    // sequence is measured first, then its source clips are overwritten back
    // onto the timeline at the nest position, trimmed to their original source
    // range. Nothing is touched unless every nest can be expanded safely.
    // ---------------------------------------------------------------------

    function failUnnest(code, message) {
        throw { openClickCode: code, message: message };
    }

    function sequenceByProjectItem(project) {
        var map = {};
        var count = 0;
        try { count = project.sequences.numSequences; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            var seq = null;
            try { seq = project.sequences[i]; } catch (eSeq) { seq = null; }
            if (!seq) continue;
            var item = null;
            try { item = seq.projectItem; } catch (eItem) { item = null; }
            var id = item ? clipNodeId(item) : "";
            if (id) map[id] = seq;
        }
        return map;
    }

    function sameNestClipRange(a, b) {
        return Math.abs(a.startTicks - b.startTicks) <= NEST_TOLERANCE_TICKS &&
            Math.abs(a.endTicks - b.endTicks) <= NEST_TOLERANCE_TICKS;
    }

    function collectNestGroups(sequence, seqByItem) {
        var entries = allClipEntries(sequence);
        var groups = [];
        var used = {};
        var i;
        var j;

        for (i = 0; i < entries.length; i++) {
            var anchor = entries[i];
            if (anchor.type !== "video" || used[anchor.nodeId]) continue;
            var nestedSeq = seqByItem[anchor.projectItemNodeId];
            if (!nestedSeq) continue;
            used[anchor.nodeId] = true;
            var group = { anchor: anchor, nestSequence: nestedSeq, audioParts: [] };
            for (j = 0; j < entries.length; j++) {
                var partner = entries[j];
                if (partner.type !== "audio" || used[partner.nodeId]) continue;
                if (partner.projectItemNodeId !== anchor.projectItemNodeId) continue;
                if (!sameNestClipRange(partner, anchor)) continue;
                used[partner.nodeId] = true;
                group.audioParts.push(partner);
            }
            groups.push(group);
        }

        for (i = 0; i < entries.length; i++) {
            var audioAnchor = entries[i];
            if (audioAnchor.type !== "audio" || used[audioAnchor.nodeId]) continue;
            var audioNest = seqByItem[audioAnchor.projectItemNodeId];
            if (!audioNest) continue;
            used[audioAnchor.nodeId] = true;
            groups.push({ anchor: audioAnchor, nestSequence: audioNest, audioParts: [] });
        }
        return groups;
    }

    function frameTicksOf(sequence) {
        var ticks = NaN;
        try { ticks = parseFloat(String(sequence.getSettings().videoFrameRate.ticks)); } catch (eSettings) { ticks = NaN; }
        return isFinite(ticks) && ticks > 0 ? ticks : NEST_TOLERANCE_TICKS;
    }

    function trackCountOf(tracks) {
        var count = 0;
        try { count = tracks.numTracks; } catch (eCount) { count = 0; }
        return count;
    }

    var UNNEST_BIN_NAME = "openClick Unnest";

    function ensureUnnestBin(project) {
        var root = null;
        try { root = project.rootItem; } catch (eRoot) { root = null; }
        if (!root) return null;
        var count = 0;
        try { count = root.children.numItems; } catch (eCount) { count = 0; }
        for (var i = 0; i < count; i++) {
            var child = null;
            try { child = root.children[i]; } catch (eChild) { child = null; }
            if (!child) continue;
            var type = -1;
            try { type = child.type; } catch (eType) { type = -1; }
            var name = "";
            try { name = String(child.name); } catch (eName) { name = ""; }
            if (type === 2 && name === UNNEST_BIN_NAME) return child;
        }
        try { return root.createBin(UNNEST_BIN_NAME); } catch (eCreateBin) { return null; }
    }

    // Track.overwriteClip ignores a project item's in/out points in current
    // Premiere builds, so trimmed restores need a subclip, which carries its
    // source range by construction. The subclip is kept (a timeline clip uses
    // it) and parked in one bin so the project stays tidy.
    function trimmedItemDurationTicks(item) {
        var inTicks = NaN;
        var outTicks = NaN;
        try { inTicks = ticksOf(item.getInPoint()); } catch (eIn) { inTicks = NaN; }
        try { outTicks = ticksOf(item.getOutPoint(4)); } catch (eOut) { outTicks = NaN; }
        return outTicks - inTicks;
    }

    function createTrimmedItem(ctx, tolerance, sourceItem, kind, inTicks, outTicks) {
        var sourceName = "";
        try { sourceName = String(sourceItem.name); } catch (eName) { sourceName = ""; }
        var wanted = outTicks - inTicks;
        // Documented units are tick strings, but some builds clamp or misread
        // them; measuring the new item shows which encoding actually took.
        var attempts = [
            { via: "subclip-ticks", start: String(Math.round(inTicks)), end: String(Math.round(outTicks)) },
            { via: "subclip-seconds", start: inTicks / TICKS_PER_SECOND, end: outTicks / TICKS_PER_SECOND }
        ];
        for (var i = 0; i < attempts.length; i++) {
            var sub = null;
            try {
                sub = sourceItem.createSubClip(
                    sourceName || "openClick clip",
                    attempts[i].start,
                    attempts[i].end,
                    1,
                    kind === "audio" ? 1 : 0,
                    kind === "video" ? 1 : 0
                );
            } catch (eCreate) { sub = null; }
            if (!sub) continue;
            var nodeId = clipNodeId(sub);
            if (!nodeId) continue;
            var measured = trimmedItemDurationTicks(sub);
            if (!isFinite(measured) || Math.abs(measured - wanted) <= tolerance) {
                return { item: sub, nodeId: nodeId, via: attempts[i].via };
            }
            ctx.trimDetail = attempts[i].via + "-duration=" + secondsText(measured);
            if (nodeId !== clipNodeId(sourceItem)) {
                deleteProjectItem(ctx.project, sub);
            }
        }
        return null;
    }

    function secondsText(ticks) {
        return (ticks / TICKS_PER_SECOND).toFixed(3) + "s";
    }

    function parkTrimmedItem(ctx, sub) {
        var bin = ensureUnnestBin(ctx.project);
        if (bin) { try { sub.moveBin(bin); } catch (eMove) {} }
    }

    function removeEmptyUnnestBin(project) {
        var root = null;
        try { root = project.rootItem; } catch (eRoot) { return; }
        var count = 0;
        try { count = root.children.numItems; } catch (eCount) { return; }
        for (var i = 0; i < count; i++) {
            var child = null;
            try { child = root.children[i]; } catch (eChild) { continue; }
            var type = -1;
            var name = "";
            try { type = child.type; } catch (eType) { type = -1; }
            try { name = String(child.name); } catch (eName) { name = ""; }
            if (type !== 2 || name !== UNNEST_BIN_NAME) continue;
            var inner = 0;
            try { inner = child.children.numItems; } catch (eInner) { inner = 0; }
            if (inner === 0) deleteProjectItem(project, child);
            return;
        }
    }

    function discardTrimmedItem(ctx, record) {
        if (!record || !record.owned || !record.item) return;
        var itemNodeId = clipNodeId(record.item);
        if (!itemNodeId) return;
        var entries = allClipEntries(ctx.sequence);
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].projectItemNodeId === itemNodeId) return;
        }
        deleteProjectItem(ctx.project, record.item);
    }

    function trackClipIds(track) {
        var ids = {};
        var count = 0;
        try { count = track.clips.numItems; } catch (eCount) { count = 0; }
        for (var c = 0; c < count; c++) {
            var id = clipNodeId(track.clips[c]);
            if (id) ids[id] = true;
        }
        return ids;
    }

    // An overwrite can only change the track it targets, so placement checks
    // stay on that track instead of rescanning the whole sequence.
    function newClipOnTrack(track, kind, trackIndex, baseIds, match) {
        var entries = entriesOnTrack(track, kind, trackIndex);
        for (var i = 0; i < entries.length; i++) {
            if (baseIds[entries[i].nodeId]) continue;
            if (match(entries[i])) return entries[i];
        }
        return null;
    }

    function removeNewClipsOnTrack(track, kind, trackIndex, baseIds) {
        for (;;) {
            var found = newClipOnTrack(track, kind, trackIndex, baseIds, function () { return true; });
            if (!found) return;
            baseIds[found.nodeId] = true;
            try { found.clip.remove(0, 0); } catch (eRemove) {}
        }
    }

    function describeNewClipOnTrack(track, kind, trackIndex, baseIds) {
        var entry = newClipOnTrack(track, kind, trackIndex, baseIds, function () { return true; });
        if (!entry) return "no-new-clip";
        return "at " + secondsText(entry.startTicks) + " for " +
            secondsText(entry.endTicks - entry.startTicks);
    }

    function insertTrimmed(ctx, tolerance, trackIndex, track, sourceItem, kind, startTicks, inTicks, outTicks) {
        var duration = outTicks - inTicks;
        var time = new Time();
        time.ticks = String(Math.round(startTicks));

        var fullIn = NaN;
        var fullOut = NaN;
        try { fullIn = ticksOf(sourceItem.getInPoint()); } catch (eFullIn) { fullIn = NaN; }
        try { fullOut = ticksOf(sourceItem.getOutPoint(4)); } catch (eFullOut) { fullOut = NaN; }
        var untrimmed = isFinite(fullIn) && isFinite(fullOut) &&
            Math.abs(inTicks - fullIn) <= tolerance &&
            Math.abs(outTicks - fullOut) <= tolerance;

        var item = sourceItem;
        var owned = false;
        var via = "source";
        if (!untrimmed) {
            var sub = createTrimmedItem(ctx, tolerance, sourceItem, kind, inTicks, outTicks);
            if (!sub) {
                ctx.trimDetail = ctx.trimDetail || "subclip-unavailable";
                ctx.trimFailed = true;
                return null;
            }
            item = sub.item;
            owned = true;
            via = sub.via;
        }

        var itemNodeId = clipNodeId(item);
        var base = trackClipIds(track);
        var matchesTarget = function (entry) {
            return Math.abs(entry.startTicks - startTicks) <= tolerance &&
                Math.abs((entry.endTicks - entry.startTicks) - duration) <= tolerance;
        };

        var placed = false;
        var found = null;
        try {
            placed = !!track.overwriteClip(item, time);
        } catch (eOverwrite) { placed = false; }
        found = newClipOnTrack(track, kind, trackIndex, base, matchesTarget);

        // Some builds drop the first overwrite after a project change, and
        // nothing has been placed yet, so retrying once is safe.
        if (!found) {
            try { placed = !!track.overwriteClip(item, time); } catch (eRetry) { placed = false; }
            found = newClipOnTrack(track, kind, trackIndex, base, matchesTarget);
        }

        if (found) {
            if (owned) parkTrimmedItem(ctx, item);
            return { nodeId: found.nodeId, item: owned ? item : null, owned: owned, via: via };
        }

        // Placement is verified by position, not by project-item id: Premiere
        // can hand the timeline a different item reference than the one passed
        // in. An item match at another time is still worth reporting.
        var wrongTime = newClipOnTrack(track, kind, trackIndex, base, function (entry) {
            return !!itemNodeId && entry.projectItemNodeId === itemNodeId;
        });
        ctx.trimDetail = via + (placed ? "-misplaced " : "-not-placed ") +
            (wrongTime
                ? "at " + secondsText(wrongTime.startTicks)
                : describeNewClipOnTrack(track, kind, trackIndex, base));
        removeNewClipsOnTrack(track, kind, trackIndex, base);
        if (owned) deleteProjectItem(ctx.project, item);
        return null;
    }

    function findClipAt(sequence, type, trackIndex, itemNodeId, startTicks, duration, tolerance) {
        var tracks = type === "video" ? sequence.videoTracks : sequence.audioTracks;
        var track = null;
        try { track = tracks[trackIndex]; } catch (eTrack) { track = null; }
        if (!track) return null;
        var entries = entriesOnTrack(track, type, trackIndex);
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.projectItemNodeId !== itemNodeId) continue;
            if (Math.abs(entry.startTicks - startTicks) > tolerance) continue;
            if (Math.abs((entry.endTicks - entry.startTicks) - duration) > tolerance) continue;
            return entry;
        }
        return null;
    }

    function findNewAudioAt(sequence, startTicks, duration, tolerance, beforeIds) {
        var audioCount = trackCountOf(sequence.audioTracks);
        for (var t = 0; t < audioCount; t++) {
            var entries = entriesOnTrack(sequence.audioTracks[t], "audio", t);
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (beforeIds[entry.nodeId]) continue;
                if (Math.abs(entry.startTicks - startTicks) > tolerance) continue;
                if (Math.abs((entry.endTicks - entry.startTicks) - duration) > tolerance) continue;
                return entry;
            }
        }
        return null;
    }

    function planNestGroup(ctx, group, seqByItem, tolerance) {
        var nestedEntries = allClipEntries(group.nestSequence, true);
        if (!nestedEntries.length) {
            failUnnest("EMPTY_NEST", "One of the nested clips is empty and cannot be expanded.");
        }

        var nestStart = group.anchor.startTicks;
        var nestEnd = group.anchor.endTicks;
        var plan = { items: [], video: 0, audio: 0 };
        for (var i = 0; i < nestedEntries.length; i++) {
            var entry = nestedEntries[i];
            if (seqByItem[entry.projectItemNodeId]) {
                failUnnest("NESTED_NEST", "A nest contains another nest. Unnest the inner nest first.");
            }
            var duration = entry.outTicks - entry.inTicks;
            if (!isFinite(duration) || duration <= 0) {
                failUnnest("UNNEST_TRIM_UNKNOWN", "A clip inside a nest could not be measured.");
            }
            var targetStart = nestStart + entry.startTicks;
            if (targetStart < nestStart - tolerance || targetStart + duration > nestEnd + tolerance) {
                failUnnest("UNNEST_RANGE_OVERFLOW", "A nest was trimmed shorter than its content and cannot be expanded safely.");
            }
            var tracks = entry.type === "video" ? ctx.sequence.videoTracks : ctx.sequence.audioTracks;
            if (entry.trackIndex >= trackCountOf(tracks)) {
                failUnnest("UNNEST_TRACK_MISSING", "A track used inside a nest is missing from this sequence.");
            }
            var item = null;
            try { item = entry.clip.projectItem; } catch (eItem) { item = null; }
            if (!item) {
                failUnnest("UNNEST_SOURCE_MISSING", "A clip inside a nest has no source media.");
            }
            plan.items.push({
                type: entry.type,
                trackIndex: entry.trackIndex,
                item: item,
                itemNodeId: entry.projectItemNodeId,
                startTicks: targetStart,
                inTicks: entry.inTicks,
                outTicks: entry.outTicks,
                duration: duration
            });
            if (entry.type === "video") plan.video++;
            else plan.audio++;
        }
        return plan;
    }

    // Premiere can refuse a trimmed overwrite. Probing it by inserting beyond
    // the sequence end produced false failures (the insert was clipped or
    // dropped there), so the real placement is the only verification: the
    // subclip's duration is validated first, then the resulting timeline clip
    // is checked by position, and a failed group rolls back.
    function removeNestGroupClips(sequence, group) {
        removeNestClipAt(sequence, group.anchor.nodeId, group.anchor.type, group.anchor.trackIndex);
        for (var i = 0; i < group.audioParts.length; i++) {
            var part = group.audioParts[i];
            removeNestClipAt(sequence, part.nodeId, "audio", part.trackIndex);
        }
    }

    function rollbackNestGroup(ctx, group, inserted) {
        var sequence = ctx.sequence;
        var i;
        for (i = 0; i < inserted.length; i++) {
            if (inserted[i].preExisting) continue;
            removeNestClip(sequence, inserted[i].nodeId);
        }
        for (i = 0; i < inserted.length; i++) {
            discardTrimmedItem(ctx, inserted[i]);
        }

        var anchor = group.anchor;
        var tracks = anchor.type === "video" ? sequence.videoTracks : sequence.audioTracks;
        var item = null;
        try { item = anchor.clip.projectItem; } catch (eItem) { item = null; }
        if (!item) return false;

        var time = new Time();
        time.ticks = String(anchor.startTicks);
        try { tracks[anchor.trackIndex].overwriteClip(item, time); } catch (eAnchor) {}

        for (i = 0; i < group.audioParts.length; i++) {
            var part = group.audioParts[i];
            if (findNestClip(sequence, part.nodeId)) continue;
            var audioTracks = sequence.audioTracks;
            if (part.trackIndex >= trackCountOf(audioTracks)) continue;
            time = new Time();
            time.ticks = String(part.startTicks);
            try { audioTracks[part.trackIndex].overwriteClip(item, time); } catch (ePart) {}
        }

        var restored = !!findNestClip(sequence, anchor.nodeId);
        for (i = 0; i < group.audioParts.length; i++) {
            if (!findNestClip(sequence, group.audioParts[i].nodeId)) restored = false;
        }
        return restored;
    }

    function expandNestGroup(ctx, group, plan, tolerance) {
        var sequence = ctx.sequence;
        var inserted = [];
        var i;
        try {
            for (i = 0; i < plan.items.length; i++) {
                var item = plan.items[i];
                var tracks = item.type === "video" ? sequence.videoTracks : sequence.audioTracks;
                var record = null;

                if (item.type === "audio") {
                    var existing = findClipAt(sequence, "audio", item.trackIndex, item.itemNodeId,
                        item.startTicks, item.duration, tolerance);
                    if (existing) {
                        record = { nodeId: existing.nodeId, item: null, owned: false, preExisting: true };
                    }
                    if (!record) {
                        // A video insert may have added linked audio already.
                        var auto = findNewAudioAt(sequence, item.startTicks, item.duration, tolerance, ctx.beforeIds);
                        if (auto) {
                            if (auto.trackIndex === item.trackIndex) {
                                record = { nodeId: auto.nodeId, item: null, owned: false };
                            } else {
                                try { auto.clip.remove(0, 0); } catch (eAuto) {}
                            }
                        }
                    }
                }

                if (!record) {
                    record = insertTrimmed(ctx, tolerance, item.trackIndex, tracks[item.trackIndex],
                        item.item, item.type, item.startTicks, item.inTicks, item.outTicks);
                }

                if (!record) {
                    if (ctx.trimFailed) {
                        failUnnest("UNNEST_TRIM_UNSUPPORTED",
                            "Premiere did not accept the trimmed source range for unnesting. Nothing was changed. (" +
                            (ctx.trimDetail || "no-subclip") + ")");
                    }
                    failUnnest(item.type === "audio" ? "UNNEST_AUDIO_FAILED" : "UNNEST_INSERT_FAILED",
                        "A clip inside a nest could not be placed back on the timeline. (" +
                        (ctx.trimDetail || "no-detail") + ")");
                }
                inserted.push(record);
            }

            removeNestGroupClips(sequence, group);

            if (findNestClipOnTrack(sequence, group.anchor.nodeId, group.anchor.type, group.anchor.trackIndex)) {
                failUnnest("UNNEST_NEST_REMAINS", "A nested clip could not be removed from the timeline.");
            }
            return inserted;
        } catch (e) {
            rollbackNestGroup(ctx, group, inserted);
            throw e;
        }
    }

    function verifyUnnest(before, after, groups, beforeIds, tolerance) {
        var difference = diffTimeline(before, after);
        var nestIds = {};
        var ranges = [];
        var i;

        for (i = 0; i < groups.length; i++) {
            nestIds[groups[i].anchor.nodeId] = true;
            for (var j = 0; j < groups[i].audioParts.length; j++) {
                nestIds[groups[i].audioParts[j].nodeId] = true;
            }
            ranges.push({ startTicks: groups[i].anchor.startTicks, endTicks: groups[i].anchor.endTicks });
        }

        for (i = 0; i < difference.removed.length; i++) {
            if (!nestIds[difference.removed[i].nodeId]) {
                return { ok: false, code: "UNNEST_COLLATERAL", message: "An unrelated clip was changed. Check the timeline." };
            }
        }
        if (difference.changed.length) {
            return { ok: false, code: "UNNEST_COLLATERAL", message: "An unrelated clip was changed. Check the timeline." };
        }

        for (i = 0; i < difference.added.length; i++) {
            var entry = difference.added[i];
            if (beforeIds[entry.nodeId]) continue;
            var inside = false;
            for (var r = 0; r < ranges.length; r++) {
                if (entry.startTicks >= ranges[r].startTicks - tolerance &&
                    entry.endTicks <= ranges[r].endTicks + tolerance) {
                    inside = true;
                    break;
                }
            }
            if (!inside) {
                return { ok: false, code: "UNNEST_COLLATERAL", message: "A clip was added outside the nest. Check the timeline." };
            }
        }
        return { ok: true, code: "OK", message: "" };
    }

    function unnestClips() {
        var ctx = {
            project: null,
            sequence: null,
            beforeIds: {},
            seqByItem: null,
            expandedGroups: 0,
            totalGroups: 0,
            selection: null,
            trimDetail: "",
            trimFailed: false
        };

        try {
            var project = null;
            try { project = app.project; } catch (eProject) { project = null; }
            if (!project) {
                failUnnest("NO_PROJECT", "Open a project first.");
            }
            ctx.project = project;

            var sequence = null;
            try { sequence = project.activeSequence; } catch (eSequence) { sequence = null; }
            if (!activeSequenceReadable(sequence)) {
                failUnnest("NO_ACTIVE_SEQUENCE", "Open a sequence first.");
            }
            ctx.sequence = sequence;

            var seqByItem = sequenceByProjectItem(project);
            ctx.seqByItem = seqByItem;
            var groups = collectNestGroups(sequence, seqByItem);
            if (!groups.length) {
                failUnnest("NO_NESTS", "No nested clips were found on the active sequence.");
            }

            var tolerance = frameTicksOf(sequence) + NEST_TOLERANCE_TICKS;
            var plans = [];
            var i;
            var before = snapshotNestTimeline(sequence);
            for (i = 0; i < before.length; i++) {
                ctx.beforeIds[before[i].nodeId] = true;
            }

            for (i = 0; i < groups.length; i++) {
                plans.push(planNestGroup(ctx, groups[i], seqByItem, tolerance));
            }
            ctx.totalGroups = groups.length;

            var selection = {};
            var clipCount = 0;
            for (i = 0; i < groups.length; i++) {
                var inserted = expandNestGroup(ctx, groups[i], plans[i], tolerance);
                var j;
                for (j = 0; j < inserted.length; j++) selection[inserted[j].nodeId] = true;
                clipCount += plans[i].video > 0 ? plans[i].video : plans[i].audio;
                ctx.expandedGroups++;
            }
            ctx.selection = selection;

            var after = snapshotNestTimeline(sequence);
            var checked = verifyUnnest(before, after, groups, ctx.beforeIds, tolerance);
            if (!checked.ok) {
                failUnnest(checked.code, checked.message);
            }

            applySelection(sequence, selection);
            return response(true, "OK", clipCount === 1 ? "Clip unnested." : "Unnested " + clipCount + " clips.");
        } catch (e) {
            var code = e && e.openClickCode ? e.openClickCode : "UNEXPECTED_ERROR";
            var message = e && e.message ? e.message : "The clips could not be unnested.";
            if (ctx.expandedGroups > 0) {
                message += " " + ctx.expandedGroups + " of " + ctx.totalGroups + " nests were expanded before the error.";
            }
            removeEmptyUnnestBin(ctx.project);
            return response(false, code, message);
        }
    }

    var OpenClick = {
        createAdjustmentLayer: createAdjustmentLayer,
        nestClips: nestClips,
        unnestClips: unnestClips
    };
    $.global.OpenClick = OpenClick;
})();
