(function (root, factory) {
  "use strict";

  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchPremiere = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  function readProjectPath(project) {
    try {
      return String(project && project.path || "").trim();
    } catch (error) {
      return "";
    }
  }

  function readProjectGuid(project) {
    try {
      if (project && project.guid && typeof project.guid.toString === "function") {
        return String(project.guid.toString()).trim();
      }
    } catch (error) {}
    return "";
  }

  function projectIdentity(project) {
    var projectPath = readProjectPath(project);
    var normalizedPath = projectPath ? Core.normalizePathForComparison(projectPath) : "";
    var guid = readProjectGuid(project);
    if (normalizedPath) return "path:" + normalizedPath + (guid ? "|guid:" + guid : "");

    // 未保存的工程没有路径；如果 Premiere 提供了 GUID，就保留该 GUID，
    // 只有在最后兜底时才使用工程名称，并明确将其视为较弱的身份依据。
    if (guid) return "guid:" + guid;
    var name = "";
    try { name = String(project && project.name || "").trim(); } catch (error) {}
    return name ? "name:" + name : "unsaved";
  }

  async function activeContext(ppro) {
    var project = null;
    try { project = await ppro.Project.getActiveProject(); } catch (error) {}
    if (!project) return null;
    var projectPath = readProjectPath(project);
    return {
      project: project,
      projectPath: projectPath,
      projectName: String(project.name || Core.basename(projectPath) || "未命名工程"),
      identity: projectIdentity(project),
      workspaceRoot: projectPath ? Core.workspaceRootForProject(projectPath) : "",
    };
  }

  async function castFolder(ppro, item) {
    try { return ppro.FolderItem.cast(item); } catch (error) { return null; }
  }

  async function castClip(ppro, item) {
    try { return ppro.ClipProjectItem.cast(item); } catch (error) { return null; }
  }

  async function inventoryProject(ppro, project) {
    var rootItem = await project.getRootItem();
    var entries = [];
    var warnings = [];
    var seenItemIds = new Set();

    async function visit(folder) {
      var items = await folder.getItems();
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        var itemId = "";
        try { itemId = String(item.getId()); } catch (error) {}
        if (itemId && seenItemIds.has(itemId)) continue;
        if (itemId) seenItemIds.add(itemId);

        var childFolder = await castFolder(ppro, item);
        if (childFolder) {
          try { await visit(childFolder); } catch (error) {
            warnings.push("无法读取分箱 " + String(item.name || "") + ": " + (error.message || error));
          }
          continue;
        }

        var clip = await castClip(ppro, item);
        if (!clip) continue;
        try {
          if (await clip.isSequence()) continue;
          var mediaPath = await clip.getMediaFilePath();
          if (!mediaPath) continue;
          entries.push({
            item: item,
            clip: clip,
            itemId: itemId,
            itemName: String(item.name || clip.name || Core.basename(mediaPath)),
            mediaPath: String(mediaPath),
          });
        } catch (error) {
          warnings.push("跳过无法读取路径的素材 " + String(item.name || "") + ": " + (error.message || error));
        }
      }
    }

    await visit(rootItem);
    return { entries: entries, warnings: warnings };
  }

  function assertCompleteInventory(inventory) {
    var warnings = inventory && Array.isArray(inventory.warnings) ? inventory.warnings : [];
    if (!warnings.length) return;
    var error = new Error("有 " + warnings.length + " 个素材项无法完整读取，本次检查未执行");
    error.code = "MATERIAL_BATCH_INVENTORY_INCOMPLETE";
    error.warningCount = warnings.length;
    throw error;
  }

  function groupByMediaPath(entries) {
    var groups = new Map();
    (entries || []).forEach(function (entry) {
      var key = Core.normalizePathForComparison(entry.mediaPath);
      if (!groups.has(key)) groups.set(key, { key: key, mediaPath: entry.mediaPath, entries: [] });
      groups.get(key).entries.push(entry);
    });
    return Array.from(groups.values());
  }

  async function contextStillActive(ppro, expectedIdentity) {
    var context = await activeContext(ppro);
    return Boolean(context && context.identity === expectedIdentity);
  }

  return {
    activeContext: activeContext,
    assertCompleteInventory: assertCompleteInventory,
    contextStillActive: contextStillActive,
    groupByMediaPath: groupByMediaPath,
    inventoryProject: inventoryProject,
    projectIdentity: projectIdentity,
  };
});
