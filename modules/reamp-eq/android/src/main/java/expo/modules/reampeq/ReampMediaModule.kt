package expo.modules.reampeq

import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Reads track length and tags (artist, title, album, bitrate, sample rate)
 * from local audio files, so the playlist can show them as soon as files are
 * added — before anything is played. Runs off the main thread.
 */
class ReampMediaModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ReampMedia")

    AsyncFunction("probe") { uris: List<String> ->
      val context = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, Any?>>()
      uris.map { uri ->
        val r = MediaMetadataRetriever()
        try {
          r.setDataSource(context, Uri.parse(uri))
          fun meta(key: Int) = r.extractMetadata(key)?.trim()?.takeIf { it.isNotEmpty() }
          val sampleRate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            meta(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE)?.toIntOrNull()
          } else null
          mapOf(
            "url" to uri,
            "duration" to (meta(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.let { it / 1000.0 }),
            "title" to meta(MediaMetadataRetriever.METADATA_KEY_TITLE),
            "artist" to (meta(MediaMetadataRetriever.METADATA_KEY_ARTIST)
              ?: meta(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)),
            "album" to meta(MediaMetadataRetriever.METADATA_KEY_ALBUM),
            "bitrate" to meta(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull(),
            "sampleRate" to sampleRate
          )
        } catch (e: Exception) {
          Log.w("ReampMedia", "Could not read $uri", e)
          mapOf("url" to uri)
        } finally {
          try { r.release() } catch (_: Exception) {}
        }
      }
    }
  }
}
