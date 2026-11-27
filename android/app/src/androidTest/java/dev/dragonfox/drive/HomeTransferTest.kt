package dev.dragonfox.drive

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.transfer.ManualTransfers
import dev.dragonfox.drive.transfer.TransferPhase
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HomeTransferTest {
    @Test fun uploadTreesAndLooseFilesThenDownloadThroughDocumentUris() = runBlocking {
        val server = InstrumentationRegistry.getArguments().getString("syncServer")
        assumeNotNull(server)
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        val id = UUID.randomUUID().toString().take(12)
        val api = DriveClient.register(requireNotNull(server), "transfer_$id", UUID.randomUUID().toString()) {}
        val base = File(app.cacheDir, "home-transfer-$id").apply { check(mkdir()) }
        val provider = FixtureDocuments(base)
        val context = object : ContextWrapper(app) {
            val documents = ContentResolver.wrap(provider)
            override fun getContentResolver(): ContentResolver = documents
            override fun getApplicationContext(): Context = this
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        lateinit var grants: Intent
        var holdingLease = false
        var denyStart = false
        var stopOnStart = false
        val transfer = ManualTransfers(context, api, scope, {}, {}, beginTransfer = { handoff, stop ->
            if (denyStart) throw IllegalStateException("Foreground service start denied")
            check(!holdingLease)
            grants = handoff
            holdingLease = true
            if (stopOnStart) stop()
            AutoCloseable { holdingLease = false }
        })
        suspend fun awaitPhase(expected: TransferPhase) {
            val final = withTimeout(60_000) {
                transfer.state.first { it.phase in setOf(TransferPhase.DONE, TransferPhase.FAILED, TransferPhase.CANCELLED) }
            }
            assertEquals(final.error, expected, final.phase)
            assertFalse("Transfer lease retained at ${final.phase}", holdingLease)
        }
        suspend fun runTask(expected: TransferPhase = TransferPhase.DONE, start: () -> Unit) {
            withContext(Dispatchers.Main.immediate) {
                transfer.dismiss()
                start()
            }
            awaitPhase(expected)
        }

        try {
            val destination = api.createFolder(null, "Device backup")
            val root = File(base, "旅行 Album").apply { check(mkdir()) }
            val nested = File(root, "Day 1").apply { check(mkdir()) }
            val empty = File(root, "空目录").apply { check(mkdir()) }
            val zero = File(root, "zero.bin").apply { check(createNewFile()) }
            val outer = File(root, "same.txt").apply { writeText("top") }
            val inner = File(nested, "same.txt").apply { writeText("another file — 東京") }

            denyStart = true
            runTask(TransferPhase.FAILED) { transfer.uploadFolder(destination.id, provider.tree(root)) }
            assertEquals(app.getString(R.string.transfer_background_unavailable), transfer.state.value.error)
            denyStart = false
            stopOnStart = true
            withContext(Dispatchers.Main.immediate) { transfer.retry() }
            awaitPhase(TransferPhase.CANCELLED)
            stopOnStart = false
            withContext(Dispatchers.Main.immediate) { transfer.retry() }
            awaitPhase(TransferPhase.DONE)
            assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION, grants.flags)
            assertEquals(provider.tree(root), grants.clipData!!.getItemAt(0).uri)
            assertEquals(3, transfer.state.value.completed)
            assertEquals(3, transfer.state.value.total)
            val folders = api.listFolders()
            val album = folders.single { it.parentId == destination.id && it.name == root.name }
            val child = folders.single { it.parentId == album.id && it.name == nested.name }
            assertEquals(setOf(empty.name, nested.name), folders.filter { it.parentId == album.id }.map { it.name }.toSet())
            val uploaded = api.listFiles()
            assertEquals(3, uploaded.size)
            assertEquals(0L, uploaded.single { it.parentId == album.id && it.name == zero.name }.size)
            assertEquals(outer.length(), uploaded.single { it.parentId == album.id && it.name == outer.name }.size)
            val source = uploaded.single { it.parentId == child.id && it.name == inner.name }

            val output = File(base, "saved.txt").apply { check(createNewFile()) }
            stopOnStart = true
            runTask(TransferPhase.CANCELLED) { transfer.download(source, provider.document(output)) }
            stopOnStart = false
            runTask { transfer.download(source, provider.document(output)) }
            assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION, grants.flags)
            assertEquals(provider.document(output), grants.clipData!!.getItemAt(0).uri)
            assertArrayEquals(inner.readBytes(), output.readBytes())
            assertEquals(inner.length(), transfer.state.value.bytes)

            val looseA = File(base, "a.txt").apply { writeText("A") }
            val looseB = File(base, "b.bin").apply { writeBytes(byteArrayOf(0, 127, -128)) }
            provider.failNextRead = looseB
            runTask(TransferPhase.FAILED) {
                transfer.uploadFiles(null, listOf(provider.document(looseA), provider.document(looseB)))
            }
            assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, grants.flags)
            val clip = requireNotNull(grants.clipData)
            assertEquals(listOf(provider.document(looseA), provider.document(looseB)), (0 until clip.itemCount).map { clip.getItemAt(it).uri })
            val successfulId = api.listFiles().single { it.parentId == null }.id
            withContext(Dispatchers.Main.immediate) { transfer.retry() }
            awaitPhase(TransferPhase.DONE)
            val loose = api.listFiles().filter { it.parentId == null }
            assertEquals(listOf(looseA.name, looseB.name), loose.map { it.name }.sorted())
            assertEquals(successfulId, loose.single { it.name == looseA.name }.id)

            output.writeText("existing local file")
            runTask(TransferPhase.FAILED) { transfer.download(source, provider.document(output)) }
            assertEquals("existing local file", output.readText())
        } finally {
            withContext(Dispatchers.Main.immediate) { transfer.close(); scope.cancel() }
            base.deleteRecursively()
            api.logout()
        }
    }
}

/** Exercises the real ContentResolver streaming and document-tree contract without installing a provider
 * or automating the system picker. The returned content URIs do not reveal a filesystem path. */
private class FixtureDocuments(private val base: File) : ContentProvider() {
    private val authority = "dev.dragonfox.test.documents"
    private val files = mutableMapOf<String, File>()
    private val ids = mutableMapOf<File, String>()
    @Volatile var failNextRead: File? = null
    private fun id(file: File) = ids.getOrPut(file) {
        UUID.randomUUID().toString().also { files[it] = file }
    }
    fun tree(dir: File): Uri = DocumentsContract.buildTreeDocumentUri(authority, id(dir))
    fun document(file: File): Uri = DocumentsContract.buildDocumentUri(authority, id(file))
    private fun file(uri: Uri): File {
        val key = if (uri.pathSegments.size == 2 && DocumentsContract.isTreeUri(uri)) DocumentsContract.getTreeDocumentId(uri)
            else DocumentsContract.getDocumentId(uri)
        return files.getValue(key)
    }

    override fun onCreate() = true
    override fun getType(uri: Uri) = mime(file(uri))
    private fun mime(file: File) = when {
        file.isDirectory -> DocumentsContract.Document.MIME_TYPE_DIR
        file.extension == "txt" -> "text/plain"
        else -> "application/octet-stream"
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?,
        sortOrder: String?): Cursor {
        val columns = projection ?: arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE)
        val parent = file(uri)
        val values = if (uri.lastPathSegment == "children") parent.listFiles()!!.sortedBy { it.name } else listOf(parent)
        return MatrixCursor(columns).apply {
            for (entry in values) addRow(columns.map { column ->
                when (column) {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID -> id(entry)
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME -> entry.name
                    DocumentsContract.Document.COLUMN_MIME_TYPE -> mime(entry)
                    // Some documents providers only know the length when the stream is consumed.
                    DocumentsContract.Document.COLUMN_SIZE -> if (entry.parentFile != base && entry.isFile) null else entry.length()
                    else -> null
                }
            })
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = file(uri)
        if (mode == "r" && failNextRead == file) {
            failNextRead = null
            throw FileNotFoundException("Temporary provider failure")
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
