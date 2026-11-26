package dev.dragonfox.drive.transfer

import android.content.ContentResolver
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import java.io.IOException

internal data class SafFile(val uri: Uri, val name: String, val mime: String, val size: Long?) {
    val directory: Boolean get() = mime == Document.MIME_TYPE_DIR
}

internal class ImportItem(val file: SafFile, val parent: ImportItem?) {
    val path: String get() = generateSequence(this) { it.parent }.map { it.file.name }.toList().asReversed().joinToString("/")
}

internal class SafDocuments(private val resolver: ContentResolver) {
    private val projection = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE)

    private fun name(value: String?): String {
        if (value.isNullOrBlank() || value == "." || value == ".." || '/' in value || '\u0000' in value) {
            throw IOException("Document provider returned an invalid name")
        }
        return value
    }

    private fun size(cursor: Cursor, column: String): Long? {
        val i = cursor.getColumnIndex(column)
        return if (i >= 0 && !cursor.isNull(i)) cursor.getLong(i).takeIf { it >= 0 } else null
    }

    fun file(uri: Uri): SafFile {
        val projection = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        resolver.query(uri, projection, null, null, null)?.use {
            if (it.moveToFirst()) return SafFile(uri, name(it.getString(it.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME))), resolver.getType(uri) ?: "application/octet-stream",
                size(it, OpenableColumns.SIZE))
        }
        throw IOException("Cannot read document information")
    }

    private fun info(tree: Uri, cursor: Cursor): SafFile {
        val id = cursor.getString(cursor.getColumnIndexOrThrow(Document.COLUMN_DOCUMENT_ID))
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
        return SafFile(uri, name(cursor.getString(cursor.getColumnIndexOrThrow(Document.COLUMN_DISPLAY_NAME))),
            cursor.getString(cursor.getColumnIndexOrThrow(Document.COLUMN_MIME_TYPE)) ?: "application/octet-stream",
            size(cursor, Document.COLUMN_SIZE))
    }

    fun tree(tree: Uri, checkActive: () -> Unit): List<ImportItem> {
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val root = resolver.query(rootUri, projection, null, null, null)?.use { if (it.moveToFirst()) info(tree, it) else null }
            ?: throw IOException("Cannot read selected folder")
        check(root.directory) { "Expected a folder" }
        val items = mutableListOf(ImportItem(root, null))
        var next = 0
        while (next < items.size) {
            checkActive()
            val parent = items[next++]
            if (!parent.file.directory) continue
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent.file.uri))
            val cursor = resolver.query(childrenUri, projection, null, null, null)
                ?: throw IOException("Cannot list ${parent.path}")
            cursor.use {
                if (it.extras.getBoolean(DocumentsContract.EXTRA_LOADING)) throw IOException("Folder is still loading: ${parent.path}")
                while (it.moveToNext()) {
                    checkActive()
                    val child = info(tree, it)
                    if (child.directory && generateSequence(parent) { p -> p.parent }.any { p -> p.file.uri == child.uri }) {
                        throw IOException("Cyclic document tree")
                    }
                    items.add(ImportItem(child, parent))
                }
            }
        }
        return items
    }

    fun input(uri: Uri) = resolver.openInputStream(uri) ?: throw IOException("Cannot open document for reading")

    fun output(uri: Uri) = resolver.openOutputStream(uri, "wt") ?: throw IOException("Cannot open document for writing")

    fun isEmpty(uri: Uri): Boolean {
        val bytes = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst()) size(it, OpenableColumns.SIZE) else null
        }
        return bytes?.let { it == 0L } ?: input(uri).use { it.read() == -1 }
    }

    fun discardOutput(uri: Uri) {
        try {
            if (DocumentsContract.deleteDocument(resolver, uri)) return
        } catch (_: Exception) { /* Some providers support truncating but not deleting. */ }
        runCatching { output(uri).close() }
    }
}
