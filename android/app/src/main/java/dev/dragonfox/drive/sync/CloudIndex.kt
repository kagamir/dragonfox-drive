package dev.dragonfox.drive.sync

import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder

internal class CloudIndex(folders: List<CloudFolder>, files: List<CloudFile>) {
    private val foldersByName = folders.associateBy { it.parentId to it.name }.toMutableMap()
    private val byId = folders.mapTo(mutableSetOf()) { it.id }
    private val filesByName = files.groupBy { it.parentId to it.name }

    fun containsFolder(id: String?): Boolean = id == null || id in byId

    fun candidates(destination: String?, path: List<String>, name: String, size: Long): List<CloudFile> {
        var id = destination
        for (part in path) id = foldersByName[id to part]?.id ?: return emptyList()
        return filesByName[id to name].orEmpty().filter { it.size == size }
    }

    // Multiple upload workers may encounter the same new parent simultaneously.
    @Synchronized
    fun ensureFolder(destination: String?, path: List<String>, create: (String?, String) -> CloudFolder): String? {
        var id = destination
        for (part in path) {
            val parent = id
            id = foldersByName.getOrPut(parent to part) { create(parent, part) }.id
        }
        return id
    }
}
