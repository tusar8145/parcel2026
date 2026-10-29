package bd.com.pairaexpress.merchant_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.media.ToneGenerator
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Adds the scanner's beep (channel "pairaexpress/beep": ok / error) with the phone's tone generator, and the
 * "Paira Express" notification channel push messages arrive on (high importance: they pop up).
 */
class MainActivity : FlutterActivity() {
    private var tones: ToneGenerator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel("pairaexpress", "Paira Express", NotificationManager.IMPORTANCE_HIGH)
            channel.description = "Parcels, payments, support replies and messages from Paira Express"
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "pairaexpress/beep").setMethodCallHandler { call, result ->
            try {
                val t = tones ?: ToneGenerator(AudioManager.STREAM_MUSIC, 100).also { tones = it }
                when (call.method) {
                    "ok" -> t.startTone(ToneGenerator.TONE_PROP_BEEP, 150)
                    else -> t.startTone(ToneGenerator.TONE_SUP_ERROR, 450)
                }
            } catch (_: RuntimeException) {
                // No audio (e.g. the phone is busy with a call): the vibration still tells the rider.
            }
            result.success(null)
        }
    }

    override fun onDestroy() {
        tones?.release()
        tones = null
        super.onDestroy()
    }
}
