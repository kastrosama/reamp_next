package expo.modules.reampeq

import android.media.audiofx.DynamicsProcessing
import android.media.audiofx.Equalizer
import android.os.Build
import android.util.Log
import expo.modules.audio.AudioPlayer
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.sqrt

/**
 * Winamp-style 10-band EQ + preamp applied to expo-audio's player.
 *
 * Android 9+ (API 28): DynamicsProcessing with 10 pre-EQ bands at Winamp's
 * exact frequencies, input gain for the preamp, and a limiter so boosts
 * don't clip. Older devices: the built-in Equalizer (usually 5 bands), with
 * Winamp's 10 sliders mapped onto the nearest device bands.
 */
class ReampEqModule : Module() {
  private val freqs = floatArrayOf(60f, 170f, 310f, 600f, 1000f, 3000f, 6000f, 12000f, 14000f, 16000f)
  private val gains = FloatArray(10)
  private var preampDb = 0f
  private var enabled = true
  private var sessionId = 0

  private var dp: DynamicsProcessing? = null
  private var legacy: Equalizer? = null

  // Upper edge of each DynamicsProcessing band: halfway (geometrically)
  // between neighbouring Winamp centre frequencies.
  private val cutoffs = FloatArray(10) { i ->
    if (i == freqs.size - 1) 20000f else sqrt(freqs[i] * freqs[i + 1])
  }

  override fun definition() = ModuleDefinition {
    Name("ReampEq")

    // Attach to the player's audio session. Safe to call repeatedly; only
    // rebuilds the effect when the session changes. Returns the session id
    // (0 = not available yet, try again after playback starts).
    AsyncFunction("attach") { player: AudioPlayer ->
      val id = player.ref.audioSessionId
      if (id > 0 && id != sessionId) {
        release()
        sessionId = id
        create()
      }
      if (dp != null || legacy != null) sessionId else 0
    }.runOnQueue(Queues.MAIN)

    Function("setBand") { index: Int, db: Double ->
      if (index in 0..9) {
        gains[index] = db.toFloat().coerceIn(-12f, 12f)
        apply(index)
      }
    }

    Function("setPreamp") { db: Double ->
      preampDb = db.toFloat().coerceIn(-12f, 12f)
      applyPreamp()
    }

    Function("setEnabled") { on: Boolean ->
      enabled = on
      try {
        dp?.enabled = on
        legacy?.enabled = on
      } catch (e: Exception) {
        Log.w(TAG, "setEnabled failed", e)
      }
    }

    OnDestroy { release() }
  }

  private fun create() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val config = DynamicsProcessing.Config.Builder(
          DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
          2,      // channels
          true, 10, // pre-EQ: 10 bands
          false, 0, // multiband compressor: off
          false, 0, // post-EQ: off
          true    // limiter
        ).build()
        val eq = DynamicsProcessing.Eq(true, true, 10)
        for (i in 0 until 10) eq.setBand(i, DynamicsProcessing.EqBand(true, cutoffs[i], gains[i]))
        config.setPreEqAllChannelsTo(eq)
        config.setLimiterAllChannelsTo(
          // attack 1ms, release 60ms, ratio 10:1, threshold -1dB, no post gain
          DynamicsProcessing.Limiter(true, true, 0, 1f, 60f, 10f, -1f, 0f)
        )
        config.setInputGainAllChannelsTo(preampDb)
        dp = DynamicsProcessing(0, sessionId, config).also { it.enabled = enabled }
      } else {
        legacy = Equalizer(0, sessionId).also { it.enabled = enabled }
        applyLegacyAll()
      }
    } catch (e: Exception) {
      Log.w(TAG, "Could not create EQ for session $sessionId", e)
      release()
    }
  }

  private fun apply(index: Int) {
    try {
      dp?.setPreEqBandAllChannelsTo(index, DynamicsProcessing.EqBand(true, cutoffs[index], gains[index]))
      if (legacy != null) applyLegacyAll()
    } catch (e: Exception) {
      Log.w(TAG, "setBand failed", e)
    }
  }

  private fun applyPreamp() {
    try {
      dp?.setInputGainAllChannelsTo(preampDb)
      if (legacy != null) applyLegacyAll()
    } catch (e: Exception) {
      Log.w(TAG, "setPreamp failed", e)
    }
  }

  // Older devices: set each device band from the nearest Winamp band (by
  // log-frequency), with the preamp added on top.
  private fun applyLegacyAll() {
    val eq = legacy ?: return
    val range = eq.bandLevelRange // millibels
    for (b in 0 until eq.numberOfBands) {
      val centreHz = eq.getCenterFreq(b.toShort()) / 1000f
      var best = 0
      var bestDist = Float.MAX_VALUE
      for (i in freqs.indices) {
        val d = abs(ln(freqs[i]) - ln(centreHz))
        if (d < bestDist) { bestDist = d; best = i }
      }
      val mb = ((gains[best] + preampDb) * 100).toInt().coerceIn(range[0].toInt(), range[1].toInt())
      eq.setBandLevel(b.toShort(), mb.toShort())
    }
  }

  private fun release() {
    try { dp?.release() } catch (_: Exception) {}
    try { legacy?.release() } catch (_: Exception) {}
    dp = null
    legacy = null
    sessionId = 0
  }

  companion object {
    private const val TAG = "ReampEq"
  }
}
