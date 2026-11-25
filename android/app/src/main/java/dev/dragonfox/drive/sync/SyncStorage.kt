package dev.dragonfox.drive.sync

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.security.MessageDigest

internal class SyncStorage(context: Context, accountScope: String) {
    private val scope = MessageDigest.getInstance("SHA-256").digest(accountScope.toByteArray()).hex()
    private val preferences = context.getSharedPreferences("sync-config-$scope", Context.MODE_PRIVATE)
    private val hashes = object : SQLiteOpenHelper(context, "sync-hashes-$scope.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) = db.execSQL(
            "CREATE TABLE hashes (entry TEXT PRIMARY KEY, revision TEXT NOT NULL, digest TEXT NOT NULL)"
        )
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    fun load(): SyncConfig {
        val sources = preferences.getStringSet("sources", emptySet()).orEmpty().toSet()
        // Before explicit per-album scopes, every selected directory was recursive.
        val recursive = preferences.getStringSet("recursiveFolders", sources).orEmpty().toSet()
        return SyncConfig(
            sources, preferences.getString("target", null),
            if (preferences.getString("mode", null) == "ALL") SyncMode.ALL else SyncMode.MEDIA,
            preferences.getBoolean("enabled", false),
            preferences.getInt("maxDepth", DEFAULT_SCAN_DEPTH),
            preferences.getInt("intervalSeconds", DEFAULT_SYNC_INTERVAL_SECONDS), recursive,
        ).normalized()
    }

    fun save(config: SyncConfig) = preferences.edit().putStringSet("sources", config.localFolders.toSet())
        .putString("target", config.remoteFolderId).putString("mode", config.mode.name)
        .putStringSet("recursiveFolders", config.recursiveFolders.toSet())
        .putInt("maxDepth", config.maxDepth).putInt("intervalSeconds", config.intervalSeconds)
        .putBoolean("enabled", config.enabled).apply()

    fun cachedDigest(key: String, version: String, calculate: () -> String): String {
        if (version.isEmpty()) return calculate()
        hashes.readableDatabase.rawQuery(
            "SELECT digest FROM hashes WHERE entry=? AND revision=?", arrayOf(key, version)
        ).use { cursor -> if (cursor.moveToFirst()) return cursor.getString(0) }
        val digest = calculate()
        hashes.writableDatabase.execSQL("INSERT OR REPLACE INTO hashes VALUES(?,?,?)", arrayOf(key, version, digest))
        return digest
    }

    fun close() = hashes.close()
}
